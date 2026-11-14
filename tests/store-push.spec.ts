// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { NotebookStore } from '../src/client/store.ts'
import { notebookEvents } from '../src/host/push.ts'

class Doc {
  visibilityState: 'visible' | 'hidden' = 'visible'
  private hs = new Set<() => void>()
  addEventListener(_t: string, h: () => void) { this.hs.add(h) }
  removeEventListener(_t: string, h: () => void) { this.hs.delete(h) }
  set(v: 'visible' | 'hidden') { this.visibilityState = v; for (const h of this.hs) h() }
}
const tick = () => new Promise<void>((r) => setTimeout(r, 0))
function streams() {
  const gens: { args: string[]; signal: AbortSignal; push(item: unknown): Promise<void> }[] = []
  const open = (sessionId: string, path: string, signal: AbortSignal): AsyncIterable<unknown> => {
    const items: unknown[] = []; let wake: (() => void) | undefined
    gens.push({ args: [sessionId, path], signal, async push(item) { items.push(item); wake?.(); await tick() } })
    signal.addEventListener('abort', () => wake?.(), { once: true })
    return { [Symbol.asyncIterator]: async function* () {
      while (!signal.aborted) { if (items.length > 0) { yield items.shift(); continue } await new Promise<void>((r) => { wake = r }) }
    } }
  }
  return { gens, open }
}
const nb = (rev: number) => ({ cells: [], rev, dirty: false, conflict: false, metadata: {}, python: '', kernel: {} }) as never

describe('NotebookStore push channel', () => {
  it('opens only on connect, applies the snapshot and events, and closes on close', async () => {
    const s = streams(); const doc = new Doc()
    const store = new NotebookStore('sess', 'a.ipynb', s.open, { host: {}, doc: doc as never })
    expect(s.gens).toHaveLength(0)
    store.connect(); store.connect()
    expect(s.gens).toHaveLength(1)
    expect(s.gens[0]!.args).toEqual(['sess', 'a.ipynb'])
    await s.gens[0]!.push({ t: 'snap', nb: nb(1) })
    expect(store.getSnapshot().connection).toBe('open')
    expect(store.getSnapshot().nb?.rev).toBe(1)
    await s.gens[0]!.push({ t: 'save', dirty: true, conflict: false })
    expect(store.getSnapshot().nb?.dirty).toBe(true)
    store.close()
    expect(s.gens[0]!.signal.aborted).toBe(true)
  })

  it('holds no connection while hidden and resyncs from the fresh snapshot on return', async () => {
    const s = streams(); const doc = new Doc()
    const store = new NotebookStore('sess', 'a.ipynb', s.open, { host: {}, doc: doc as never })
    store.connect()
    await s.gens[0]!.push({ t: 'snap', nb: nb(1) })
    doc.set('hidden')
    expect(s.gens[0]!.signal.aborted).toBe(true)
    doc.set('visible')
    expect(s.gens).toHaveLength(2)
    await s.gens[1]!.push({ t: 'snap', nb: nb(5) })
    expect(store.getSnapshot().nb?.rev).toBe(5)
    store.close()
  })

  it('two views of one notebook on a page share one stream', async () => {
    const s = streams(); const host = {}; const doc = new Doc()
    const a = new NotebookStore('sess', 'a.ipynb', s.open, { host, doc: doc as never })
    const b = new NotebookStore('sess', 'a.ipynb', s.open, { host, doc: doc as never })
    a.connect(); b.connect()
    expect(s.gens).toHaveLength(1)
    await s.gens[0]!.push({ t: 'snap', nb: nb(2) })
    expect(a.getSnapshot().nb?.rev).toBe(2); expect(b.getSnapshot().nb?.rev).toBe(2)
    a.close(); expect(s.gens[0]!.signal.aborted).toBe(false)
    b.close(); expect(s.gens[0]!.signal.aborted).toBe(true)
  })

  it('a final refusal surfaces as closed and stops retrying', async () => {
    vi.useFakeTimers()
    try {
      vi.stubGlobal('fetch', vi.fn(async () => ({ status: 403, json: async () => ({ ok: false, error: { code: 'outside-workspace', message: 'no' } }) })))
      let attempts = 0
      const open = (): AsyncIterable<unknown> => { attempts++; return { [Symbol.asyncIterator]: () => ({ next: () => Promise.reject(new Error('refused')) }) } }
      const store = new NotebookStore('sess', 'x.ipynb', open, { host: {}, doc: new Doc() as never })
      store.connect()
      await vi.advanceTimersByTimeAsync(5 * 60_000)
      expect(attempts).toBe(1)
      expect(store.getSnapshot().connection).toBe('closed')
      store.close()
    } finally { vi.unstubAllGlobals(); vi.useRealTimers() }
  })
})

describe('host notebookEvents', () => {
  it('refuses non-string arguments', async () => {
    const it = notebookEvents({} as never, {} as never, 5 as never, 'p', undefined)
    await expect(it.next()).rejects.toThrow(/required/)
  })
})
