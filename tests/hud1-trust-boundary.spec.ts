// HUD-1 / HUD-4 regression tests: no tokenised URL, danger-full-access sessions are off limits, safe socket handling.
import { mkdtempSync, writeFileSync, symlinkSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { connect, type Socket } from 'node:net'
import { describe, expect, it } from 'vitest'
import { Bridge, MAX_CONNECTIONS } from '../src/host/bridge.ts'
import { Harness, stripCredentials } from '../src/host/harness.ts'
import type { Config } from '../src/host/config.ts'

const log = { info() {}, warn() {}, debug() {} }

function makeHarness(opts: { modes: Record<string, string>; defaultMode?: string; allow?: boolean; url?: string }) {
  const calls: string[] = []
  const config = { enabled: true, allowDangerousSessions: opts.allow === true, socketPath: '', workspace: '', model: '', provider: '', effort: '' } as Config
  const sessions = { get: (id: string) => (id in opts.modes ? { id, mode: opts.modes[id] } : undefined) }
  const sandboxPolicy = { resolve: (r?: { session?: { mode?: string } }) => ({ mode: r?.session?.mode ?? opts.defaultMode ?? 'workspace-write' }) }
  const controller = {
    prompt: async (r: { sessionId: string }) => { calls.push(`prompt:${r.sessionId}`) },
    create: async () => { calls.push('create'); return { sessionId: 'new1' } },
    list: async () => ({ items: [] }),
    modelCatalog: async () => ({ groups: [] }),
    cancel: () => {},
    follow: async function* () {},
  }
  const authenticatedUrl = (u: string) => `${u}?token=SECRET`
  const ctx = {
    get: (name: string) => ({
      sessions, sandboxPolicy, sessionController: controller,
      webApp: { getAdvertisedUrl: () => opts.url ?? 'http://127.0.0.1:3090/' },
      connection: { authenticatedUrl },
      workspaceRegistry: { list: () => [{ workspaceId: 'w1', title: 'W', path: '/w' }] },
    } as Record<string, unknown>)[name],
  }
  return { harness: new Harness(ctx as never, () => config), calls }
}

async function rpc(path: string, calls: [string, Record<string, unknown>][]): Promise<Record<number, { result?: Record<string, unknown>; error?: { code: number; message: string } }>> {
  const socket = connect(path)
  const out: Record<number, { result?: Record<string, unknown>; error?: { code: number; message: string } }> = {}
  let buf = ''
  socket.on('data', (d) => { buf += String(d); for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) { const m = JSON.parse(buf.slice(0, i)) as { id?: number }; if (m.id !== undefined) out[m.id] = m as never; buf = buf.slice(i + 1) } })
  await new Promise((r) => socket.once('connect', r))
  calls.forEach(([method, params], i) => socket.write(JSON.stringify({ jsonrpc: '2.0', id: i + 1, method, params }) + '\n'))
  await new Promise((r) => setTimeout(r, 150))
  socket.destroy()
  return out
}

async function serve(harness: Harness): Promise<{ path: string; bridge: Bridge }> {
  const path = join(mkdtempSync(join(tmpdir(), 'hud1-')), 'a.sock')
  const bridge = new Bridge(harness, log, { home: '/h', socket: path, workspace: () => '', model: () => 'm' }, '0')
  expect(await bridge.listen(path)).toBe(true)
  return { path, bridge }
}

describe('HUD-1: web/url is the plain advertised URL', () => {
  it('never contains a token, userinfo or query', async () => {
    const { harness } = makeHarness({ modes: { s1: 'workspace-write' }, url: 'http://user:pw@127.0.0.1:3090/?token=abc&x=1#frag' })
    const { path, bridge } = await serve(harness)
    const r = await rpc(path, [['web/url', {}], ['web/url', { sessionId: 's1' }]])
    expect(r[1]?.result?.['url']).toBe('http://127.0.0.1:3090/')
    expect(r[2]?.result?.['url']).toBe('http://127.0.0.1:3090/#dsh-hud-session=s1')
    expect(JSON.stringify(r)).not.toMatch(/token|SECRET|pw@/)
    bridge.close()
  })
  it('stripCredentials drops userinfo, query and fragment', () => {
    expect(stripCredentials('https://a:b@host:1/p?token=1#h')).toBe('https://host:1/p')
  })
})

describe('HUD-1: sessions in danger-full-access are off limits by default', () => {
  it('refuses prompt/select on a danger-full-access session, allows read-only and workspace-write', async () => {
    const { harness, calls } = makeHarness({ modes: { danger: 'danger-full-access', ro: 'read-only', ww: 'workspace-write' } })
    const { path, bridge } = await serve(harness)
    const r = await rpc(path, [
      ['session/prompt', { sessionId: 'danger', text: 'rm -rf ~' }],
      ['session/prompt', { sessionId: 'ro', text: 'hi' }],
      ['session/prompt', { sessionId: 'ww', text: 'hi' }],
      ['session/prompt', { sessionId: 'unloaded', text: 'hi' }],
      ['session/select', { sessionId: 'danger', provider: 'p', model: 'm' }],
    ])
    expect(r[1]?.error?.code).toBe(-32003)
    expect(r[1]?.error?.message).toMatch(/danger-full-access/)
    expect(r[2]?.result?.['accepted']).toBe(true)
    expect(r[3]?.result?.['accepted']).toBe(true)
    expect(r[4]?.error?.code).toBe(-32003) // unknown mode fails closed
    expect(r[5]?.error?.code).toBe(-32003)
    expect(calls).toEqual(['prompt:ro', 'prompt:ww'])
    bridge.close()
  })
  it('refuses session/create when new sessions would start in danger-full-access', async () => {
    const dangerous = makeHarness({ modes: {}, defaultMode: 'danger-full-access' })
    const a = await serve(dangerous.harness)
    const r = await rpc(a.path, [['session/create', {}]])
    expect(r[1]?.error?.code).toBe(-32003)
    expect(dangerous.calls).not.toContain('create')
    a.bridge.close()
    const safe = makeHarness({ modes: {}, defaultMode: 'workspace-write' })
    const b = await serve(safe.harness)
    expect((await rpc(b.path, [['session/create', {}]]))[1]?.result?.['sessionId']).toBe('new1')
    b.bridge.close()
  })
  it('the operator can opt in with allowDangerousSessions', async () => {
    const { harness, calls } = makeHarness({ modes: { danger: 'danger-full-access' }, defaultMode: 'danger-full-access', allow: true })
    const { path, bridge } = await serve(harness)
    const r = await rpc(path, [['session/prompt', { sessionId: 'danger', text: 'x' }], ['session/create', {}]])
    expect(r[1]?.result?.['accepted']).toBe(true)
    expect(r[2]?.result?.['sessionId']).toBe('new1')
    expect(calls).toEqual(['prompt:danger', 'create'])
    bridge.close()
  })
})

describe('HUD-4: socket path handling', () => {
  it('does not delete a regular file or follow a symlink at the configured path', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hud4-'))
    const file = join(dir, 'precious')
    writeFileSync(file, 'keep me')
    const { harness } = makeHarness({ modes: {} })
    const bridge = new Bridge(harness, log, { home: '/h', socket: file, workspace: () => '', model: () => 'm' }, '0')
    expect(await bridge.listen(file)).toBe(false)
    expect(existsSync(file)).toBe(true)
    const link = join(dir, 'link.sock')
    symlinkSync(file, link)
    expect(await bridge.listen(link)).toBe(false)
    expect(existsSync(file)).toBe(true)
  })
  it(`caps concurrent connections at ${MAX_CONNECTIONS}`, async () => {
    const { harness } = makeHarness({ modes: {} })
    const { path, bridge } = await serve(harness)
    const sockets: Socket[] = []
    for (let i = 0; i < MAX_CONNECTIONS + 4; i++) {
      const s = connect(path); s.on('error', () => {}); sockets.push(s)
      await new Promise((r) => setTimeout(r, 15))
    }
    await new Promise((r) => setTimeout(r, 100))
    expect(sockets.filter((s) => !s.destroyed).length).toBe(MAX_CONNECTIONS)
    sockets.forEach((s) => s.destroy()); bridge.close()
  })
})
