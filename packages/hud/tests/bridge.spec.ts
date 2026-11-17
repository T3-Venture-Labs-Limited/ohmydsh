import { mkdtempSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { connect } from 'node:net'
import { describe, expect, it } from 'vitest'
import { Bridge } from '../src/host/bridge.ts'
import type { Harness } from '../src/host/harness.ts'

const fake = {
  describe: () => ({ fake: true }),
  workspaces: () => [{ workspaceId: 'w1', title: 'W', path: '/w' }],
  sessions: async () => [{ sessionId: 's1', updatedAt: 1, running: false, blank: false }],
  webUrl: (id?: string) => `http://x/${id === undefined ? '' : `#dsh-hud-session=${id}`}`,
} as unknown as Harness
const log = { info() {}, warn() {}, debug() {} }

describe('bridge', () => {
  it('serves hello, lists, web/url and rejects unknown methods over a 0600 socket', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'hud-')), 'a.sock')
    const bridge = new Bridge(fake, log, { home: '/h', socket: path, workspace: () => '', model: () => 'm' }, '0.1.0')
    expect(await bridge.listen(path)).toBe(true)
    expect(statSync(path).mode & 0o777).toBe(0o600)
    const socket = connect(path)
    const lines: Record<string, unknown>[] = []
    let buf = ''
    socket.on('data', (d) => { buf += String(d); for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) { lines.push(JSON.parse(buf.slice(0, i)) as Record<string, unknown>); buf = buf.slice(i + 1) } })
    await new Promise((r) => socket.once('connect', r))
    for (const [id, method, params] of [[1, 'hello', {}], [2, 'sessions/list', {}], [3, 'web/url', { sessionId: 's1' }], [4, 'nope', {}]] as const) {
      socket.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    }
    await new Promise((r) => setTimeout(r, 100))
    const by = (id: number) => lines.find((l) => l['id'] === id) as { result?: Record<string, unknown>; error?: { code: number } }
    expect(by(1).result?.['protocol']).toBe('dsh-hud/1')
    expect((by(2).result?.['items'] as unknown[]).length).toBe(1)
    expect(by(3).result?.['url']).toContain('#dsh-hud-session=s1')
    expect(by(4).error?.code).toBe(-32601)
    socket.destroy(); bridge.close()
  })
})
