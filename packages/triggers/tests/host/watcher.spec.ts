// @vitest-environment node
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TriggersEngine } from '../../src/host/engine.ts'
import { TriggersStore } from '../../src/host/store.ts'
import { FileWatcher, scanFiles, siblingHolds, type FileMatch } from '../../src/host/watcher.ts'
import type { FileSource } from '../../src/shared/types.ts'
import { log, sleep, tempDir, until } from './helpers.ts'

let dir: string; let cleanup: () => Promise<void>
const running: { stop(): void }[] = []
beforeEach(async () => { ({ dir, cleanup } = await tempDir('triggers-watch-')) })
afterEach(async () => { for (const w of running.splice(0)) w.stop(); await cleanup() })

const SETTLE = 150

function memoryDeps(onMatch: (m: FileMatch) => Promise<boolean> = async () => true, catchUpMs?: number) {
  const known = new Set<string>(); let baseline: string | undefined
  const matches: FileMatch[] = []
  return {
    known, matches,
    deps: {
      isKnown: (r: string) => known.has(r), markKnown: (rs: readonly string[]) => { for (const r of rs) known.add(r) },
      hasBaseline: (k: string) => baseline === k, markBaseline: (k: string) => { baseline = k },
      onMatch: async (m: FileMatch) => { matches.push(m); return onMatch(m) }, log,
      ...(catchUpMs === undefined ? {} : { catchUpMs }),
    },
  }
}
function source(root: string, extra: Partial<FileSource> = {}): FileSource {
  return { kind: 'file', path: root, pattern: 'transcript.md', settleMs: SETTLE, ignoreExisting: true, ...extra }
}
async function startWatcher(src: FileSource, deps: ReturnType<typeof memoryDeps>['deps']): Promise<FileWatcher> {
  const w = new FileWatcher('a1', src, deps); running.push(w)
  await w.start()
  return w
}

describe('file watcher', () => {
  it('baselines existing matches (no back catalogue) and fires a new file only after it settles', async () => {
    const root = join(dir, 'meetings')
    await mkdir(join(root, 'old'), { recursive: true })
    await writeFile(join(root, 'old', 'transcript.md'), 'old')
    const m = memoryDeps()
    await startWatcher(source(root), m.deps)
    await mkdir(join(root, 'new1'))
    await writeFile(join(root, 'new1', 'transcript.md'), 'part 1')
    await sleep(SETTLE / 2)
    await writeFile(join(root, 'new1', 'transcript.md'), 'part 1 + 2') // still being written: debounce restarts
    await sleep(SETTLE / 2)
    expect(m.matches).toHaveLength(0)
    await until(() => m.matches.length === 1)
    await sleep(SETTLE * 2)
    expect(m.matches).toHaveLength(1)
    const hit = m.matches[0] as FileMatch
    expect(hit.file).toMatchObject({ name: 'transcript.md', dirname: 'new1', dir: join(root, 'new1'), size: 10 })
    expect(hit.file.path).toBe(join(root, 'new1', 'transcript.md'))
    expect(hit).not.toHaveProperty('content')
  })

  it('picks up a file in a subdirectory created after start (two levels deep), ignores non-matching names', async () => {
    const root = join(dir, 'meetings'); await mkdir(root)
    const m = memoryDeps()
    await startWatcher(source(root), m.deps)
    await mkdir(join(root, '2026-11-16-ab12', 'nested'), { recursive: true })
    await writeFile(join(root, '2026-11-16-ab12', 'notes.txt'), 'x')
    await writeFile(join(root, '2026-11-16-ab12', 'transcript.md'), 'hello')
    await sleep(30)
    await writeFile(join(root, '2026-11-16-ab12', 'nested', 'transcript.md'), 'deep')
    await until(() => m.matches.length === 2)
    expect(m.matches.map((x) => x.file.dirname).sort()).toEqual(['2026-11-16-ab12', 'nested'])
  })

  it('does not fire a re-written file twice', async () => {
    const root = join(dir, 'm'); await mkdir(root)
    const m = memoryDeps()
    await startWatcher(source(root), m.deps)
    await mkdir(join(root, 'd'))
    await writeFile(join(root, 'd', 'transcript.md'), 'v1')
    await until(() => m.matches.length === 1)
    await writeFile(join(root, 'd', 'transcript.md'), 'v2')
    await sleep(SETTLE * 3)
    expect(m.matches).toHaveLength(1)
  })

  it('requireSibling: waits until the sibling JSON satisfies the condition (re-checked on sibling writes)', async () => {
    const root = join(dir, 'm'); await mkdir(root)
    const m = memoryDeps()
    await startWatcher(source(root, { requireSibling: { file: 'metadata.json', field: 'status', equals: 'completed' } }), m.deps)
    await mkdir(join(root, 'meet'))
    await writeFile(join(root, 'meet', 'metadata.json'), JSON.stringify({ status: 'active' }))
    await writeFile(join(root, 'meet', 'transcript.md'), 'text')
    await sleep(SETTLE * 3)
    expect(m.matches).toHaveLength(0)
    await writeFile(join(root, 'meet', 'metadata.json'), JSON.stringify({ status: 'completed', id: 'x' }))
    await until(() => m.matches.length === 1)
    expect(m.matches[0]?.sibling).toEqual({ status: 'completed', id: 'x' })
  })

  it('catch-up after restart: files created while down fire, baseline is not retaken', async () => {
    const root = join(dir, 'm'); await mkdir(join(root, 'before'), { recursive: true })
    await writeFile(join(root, 'before', 'transcript.md'), 'old')
    const m = memoryDeps()
    const first = await startWatcher(source(root, { settleMs: 20 }), m.deps)
    first.stop()
    // "DSH is down": a meeting finishes
    await mkdir(join(root, 'while-down'))
    await writeFile(join(root, 'while-down', 'transcript.md'), 'missed')
    await sleep(40)
    await startWatcher(source(root, { settleMs: 20 }), m.deps)
    await until(() => m.matches.length === 1)
    expect(m.matches[0]?.file.dirname).toBe('while-down')
  })

  it('a match that is not consumed (e.g. rate limited) is retried by the periodic scan', async () => {
    const root = join(dir, 'm'); await mkdir(root)
    let accept = false
    const m = memoryDeps(async () => accept, 200)
    await startWatcher(source(root, { settleMs: 20 }), m.deps)
    await mkdir(join(root, 'd'))
    await writeFile(join(root, 'd', 'transcript.md'), 'x')
    await until(() => m.matches.length === 1)
    accept = true
    await until(() => m.matches.length === 2, 3000)
    await sleep(500)
    expect(m.matches).toHaveLength(2)
  })

  it('a missing root is tolerated and watched once it appears (next scan)', async () => {
    const root = join(dir, 'later')
    const m = memoryDeps(async () => true, 150)
    await startWatcher(source(root, { settleMs: 20 }), m.deps)
    await mkdir(join(root, 'd'), { recursive: true })
    await writeFile(join(root, 'd', 'transcript.md'), 'x')
    await until(() => m.matches.length === 1, 3000)
  })

  it('scan is bounded and siblingHolds compares strings', async () => {
    await mkdir(join(dir, 'a', 'b', 'c', 'd', 'e', 'f'), { recursive: true })
    await writeFile(join(dir, 'a', 'b', 'c', 'd', 'e', 'f', 'x.md'), '')
    await writeFile(join(dir, 'a', 'x.md'), '')
    expect(await scanFiles(dir, (n) => n === 'x.md')).toEqual([join(dir, 'a', 'x.md')])
    expect(siblingHolds({ status: 'completed' }, 'status', 'completed')).toBe(true)
    expect(siblingHolds({ a: { n: 3 } }, 'a.n', '3')).toBe(true)
    expect(siblingHolds({}, 'status', 'completed')).toBe(false)
  })
})

describe('engine + file source', () => {
  it('a new transcript fires one delivery; the back catalogue never fires; persisted across restart', async () => {
    const root = join(dir, 'meetings'); await mkdir(join(root, 'old'), { recursive: true })
    await writeFile(join(root, 'old', 'transcript.md'), 'old')
    const storeDir = join(dir, 'state')
    const make = async () => {
      const store = new TriggersStore(storeDir); await store.load()
      const deliver = vi.fn(async () => ({ sessionId: 's1' }))
      const engine = new TriggersEngine({ store, deliver, origin: () => '', hasAutomationModels: () => false, hasComposio: () => false, workspaces: () => [], defaultCwd: () => dir, log })
      running.push(engine)
      return { store, engine, deliver }
    }
    const one = await make()
    await one.engine.save({ name: 'Meeting summary', source: { kind: 'file', path: root, pattern: 'transcript.md', settleMs: 50 }, target: { mode: 'new', cwd: dir, title: 'Meeting: {{file.dirname}}' }, prompt: 'Summarise {{file.path}}. {{event_fenced}}' })
    const id = one.store.data.automations[0]?.id as string
    await one.engine.watcher(id)?.whenReady()
    await mkdir(join(root, 'm2'))
    await writeFile(join(root, 'm2', 'transcript.md'), 'new meeting')
    await until(() => one.deliver.mock.calls.length === 1)
    const call = one.deliver.mock.calls[0] as unknown as [unknown, { title: string; text: string }]
    expect(call[1].title).toBe('Meeting: m2')
    expect(call[1].text).toContain(`Summarise ${join(root, 'm2', 'transcript.md')}.`)
    expect(call[1].text).not.toContain('new meeting') // content is never read into the prompt
    await until(() => one.store.recentRuns()[0]?.status === 'delivered')
    one.engine.stop(); await one.store.flushed()

    const two = await make()
    two.engine.syncWatchers()
    await two.engine.watcher(id)?.whenReady()
    await sleep(200)
    expect(two.deliver).not.toHaveBeenCalled()
  })
})
