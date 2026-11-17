import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The live channel is a shared Typert stream: one per page, open only while a surface is retained and the page is visible.
class Doc {
  visibilityState: 'visible' | 'hidden' = 'visible'
  private hs = new Set<() => void>()
  addEventListener(_t: string, h: () => void) { this.hs.add(h) }
  removeEventListener(_t: string, h: () => void) { this.hs.delete(h) }
  set(v: 'visible' | 'hidden') { this.visibilityState = v; for (const h of this.hs) h() }
}
const tick = (): Promise<unknown> => vi.isFakeTimers() ? vi.advanceTimersByTimeAsync(0) : new Promise<void>((r) => setTimeout(r, 0))
function streams() {
  const gens: { signal: AbortSignal; push(item: unknown): Promise<void> }[] = []
  const open = (signal: AbortSignal): AsyncIterable<unknown> => {
    const items: unknown[] = []; let wake: (() => void) | undefined
    gens.push({ signal, async push(item) { items.push(item); wake?.(); await tick() } })
    signal.addEventListener('abort', () => wake?.(), { once: true })
    return { [Symbol.asyncIterator]: async function* () {
      while (!signal.aborted) { if (items.length > 0) { yield items.shift(); continue } await new Promise<void>((r) => { wake = r }) }
    } }
  }
  return { gens, open }
}
const job = (id: string, state: string, updatedAt = 1) => ({ id, state, updatedAt, assetIds: [], prompt: '' })

let live: typeof import('../src/client/workbench/live.js')
beforeEach(async () => {
  vi.resetModules()
  ;(globalThis as Record<string, unknown>)['__dshStudioShared_v1'] = undefined
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ jobs: [] }) })))
  live = await import('../src/client/workbench/live.js')
})
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })

describe('studio live channel', () => {
  it('opens nothing until a surface is retained, shares one stream, and closes 5 s after the last release', async () => {
    vi.useFakeTimers()
    const s = streams(); const doc = new Doc()
    live.configureLive(s.open, { host: {}, doc: doc as never })
    expect(s.gens).toHaveLength(0)
    const a = live.retainLive(); const b = live.retainLive()
    expect(s.gens).toHaveLength(1)
    await s.gens[0]!.push({ event: 'job', data: job('j1', 'running') })
    expect(live.liveStore.get().jobs['j1']?.state).toBe('running')
    expect(live.liveStore.get().connected).toBe(true)
    a(); await vi.advanceTimersByTimeAsync(6000); expect(s.gens[0]!.signal.aborted).toBe(false)
    b(); await vi.advanceTimersByTimeAsync(6000)
    expect(s.gens[0]!.signal.aborted).toBe(true)
    expect(live.liveStore.get().connected).toBe(false)
  })

  it('releases the connection while the page is hidden and reloads the list when it returns', async () => {
    const s = streams(); const doc = new Doc()
    live.configureLive(s.open, { host: {}, doc: doc as never })
    const release = live.retainLive()
    await s.gens[0]!.push({ event: 'snapshot', data: { jobs: [job('a', 'running')] } })
    const calls = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.length
    doc.set('hidden')
    expect(s.gens[0]!.signal.aborted).toBe(true)
    doc.set('visible')
    expect(s.gens).toHaveLength(2)
    await s.gens[1]!.push({ event: 'job', data: job('a', 'succeeded', 2) })
    expect((fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(calls)
    expect(live.liveStore.get().jobs['a']?.state).toBe('succeeded')
    release()
  })

  it('delivers asset frames to listeners', async () => {
    const s = streams()
    live.configureLive(s.open, { host: {}, doc: new Doc() as never })
    const seen: unknown[] = []
    const off = live.onAsset((a) => seen.push(a))
    const release = live.retainLive()
    await s.gens[0]!.push({ event: 'asset', data: { id: 'x1' } })
    expect(seen).toEqual([{ id: 'x1' }])
    off(); release()
  })
})
