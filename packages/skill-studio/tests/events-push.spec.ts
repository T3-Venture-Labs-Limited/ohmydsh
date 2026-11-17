// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest'
import { configureSummary, subscribeSummary } from '../src/client/events.ts'
import { summaryStream } from '../src/host/push.ts'

class Doc {
  visibilityState: 'visible' | 'hidden' = 'visible'
  private hs = new Set<() => void>()
  addEventListener(_t: string, h: () => void) { this.hs.add(h) }
  removeEventListener(_t: string, h: () => void) { this.hs.delete(h) }
  set(v: 'visible' | 'hidden') { this.visibilityState = v; for (const h of this.hs) h() }
}
const tick = () => new Promise<void>((r) => setTimeout(r, 0))
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
afterEach(() => { configureSummary(undefined) })

describe('summary push channel', () => {
  it('holds no connection until a consumer mounts, shares one stream, and releases it with the last consumer', async () => {
    const s = streams(); const doc = new Doc()
    configureSummary(s.open, { host: {}, doc: doc as never })
    expect(s.gens).toHaveLength(0)
    const a: number[] = []; const b: number[] = []
    const offA = subscribeSummary((x) => a.push(x.pending))
    const offB = subscribeSummary((x) => b.push(x.pending))
    expect(s.gens).toHaveLength(1)
    await s.gens[0]!.push({ pending: 2, sessions: ['s'], reviewing: false })
    expect(a.at(-1)).toBe(2); expect(b.at(-1)).toBe(2)
    offA(); expect(s.gens[0]!.signal.aborted).toBe(false)
    offB(); expect(s.gens[0]!.signal.aborted).toBe(true)
  })

  it('closes while the page is hidden and reopens when it is visible', async () => {
    const s = streams(); const doc = new Doc()
    configureSummary(s.open, { host: {}, doc: doc as never })
    const off = subscribeSummary(() => {})
    expect(s.gens).toHaveLength(1)
    doc.set('hidden')
    expect(s.gens[0]!.signal.aborted).toBe(true)
    doc.set('visible')
    expect(s.gens).toHaveLength(2)
    off()
    expect(s.gens[1]!.signal.aborted).toBe(true)
  })

  it('ignores malformed items', async () => {
    const s = streams()
    configureSummary(s.open, { host: {}, doc: new Doc() as never })
    const seen: number[] = []
    const off = subscribeSummary((x) => seen.push(x.pending))
    await s.gens[0]!.push({ nope: true })
    await s.gens[0]!.push({ pending: 1, sessions: [], reviewing: false })
    expect(seen).toEqual([0, 1])
    off()
  })
})

describe('host summary stream', () => {
  it('yields the current summary first and then every change, and unsubscribes when cancelled', async () => {
    let n = 0; const ls = new Set<() => void>()
    const face = { summary: () => ({ pending: n }), subscribe: (l: () => void) => { ls.add(l); return () => { ls.delete(l) } } }
    const abort = new AbortController(); const out: number[] = []
    const reader = (async () => { for await (const x of summaryStream(face, abort.signal)) out.push(x.pending) })()
    await tick()
    n = 1; for (const l of ls) l()
    await tick()
    abort.abort(); await reader
    expect(out).toEqual([0, 1])
    expect(ls.size).toBe(0)
  })
})
