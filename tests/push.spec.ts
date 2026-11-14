// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { MIN_POLL_MS, openPushStreams, subscribePush } from '../ui/push/client.ts'
import { createPushTransport, pushContribution } from '../ui/push/transport.ts'
import type { PushSource } from '../ui/push/client.ts'
import { REMOTE_METHOD_DESCRIPTOR, pushIterable, registerPushRemote } from '../ui/push/host.ts'

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

class FakeDoc {
  visibilityState: 'visible' | 'hidden' = 'visible'
  private handlers = new Set<() => void>()
  addEventListener(_t: string, h: () => void) { this.handlers.add(h) }
  removeEventListener(_t: string, h: () => void) { this.handlers.delete(h) }
  set(state: 'visible' | 'hidden') { this.visibilityState = state; for (const h of this.handlers) h() }
}

/** A source whose generations the test controls. */
function rig(extra: Partial<PushSource<number>> = {}) {
  const generations: { signal: AbortSignal; push(n: number): Promise<void> }[] = []
  const source: PushSource<number> = {
    id: 'p',
    open(signal) {
      const items: number[] = []
      let wake: (() => void) | undefined
      const gen = { signal, async push(n: number) { items.push(n); wake?.(); await tick() } }
      generations.push(gen)
      signal.addEventListener('abort', () => wake?.(), { once: true })
      return { [Symbol.asyncIterator]: async function* () {
        while (!signal.aborted) {
          if (items.length > 0) { yield items.shift() as number; continue }
          await new Promise<void>((resolve) => { wake = resolve })
        }
      } }
    },
    ...extra,
  }
  return { source, generations, host: {}, doc: new FakeDoc() }
}

describe('subscribePush', () => {
  it('opens only while a consumer is mounted and closes with the last one', async () => {
    const r = rig()
    expect(r.generations).toHaveLength(0)
    const got: number[] = []
    const off = subscribePush(r.source, (n) => got.push(n), { host: r.host, doc: r.doc as never })
    expect(openPushStreams(r.host)).toBe(1)
    await r.generations[0]!.push(1)
    expect(got).toEqual([1])
    off()
    expect(openPushStreams(r.host)).toBe(0)
    expect(r.generations[0]!.signal.aborted).toBe(true)
  })

  it('holds no stream while the page is hidden and resumes (resyncing) when it is visible again', async () => {
    const onOpen = vi.fn()
    const r = rig({ onOpen })
    r.doc.set('hidden')
    const got: number[] = []
    const off = subscribePush(r.source, (n) => got.push(n), { host: r.host, doc: r.doc as never })
    expect(r.generations).toHaveLength(0)
    expect(openPushStreams(r.host)).toBe(0)
    r.doc.set('visible')
    expect(r.generations).toHaveLength(1)
    await r.generations[0]!.push(7)
    expect(onOpen).toHaveBeenCalledTimes(1)
    r.doc.set('hidden')
    expect(r.generations[0]!.signal.aborted).toBe(true)
    expect(openPushStreams(r.host)).toBe(0)
    r.doc.set('visible')
    expect(r.generations).toHaveLength(2)
    await r.generations[1]!.push(8)
    expect(onOpen).toHaveBeenCalledTimes(2)
    expect(got).toEqual([7, 8])
    off()
  })

  it('shares one stream per id however many times it is mounted, and replays the last item to a late joiner', async () => {
    const r = rig()
    const a: number[] = []
    const b: number[] = []
    const offA = subscribePush(r.source, (n) => a.push(n), { host: r.host, doc: r.doc as never })
    await r.generations[0]!.push(1)
    const offB = subscribePush(r.source, (n) => b.push(n), { host: r.host, doc: r.doc as never })
    expect(r.generations).toHaveLength(1)
    expect(openPushStreams(r.host)).toBe(1)
    expect(b).toEqual([1])
    await r.generations[0]!.push(2)
    expect(a).toEqual([1, 2])
    expect(b).toEqual([1, 2])
    offA()
    expect(r.generations[0]!.signal.aborted).toBe(false)
    offB()
    expect(r.generations[0]!.signal.aborted).toBe(true)
  })

  it('does not replay when the source is a delta stream', async () => {
    const r = rig({ replay: false })
    subscribePush(r.source, () => {}, { host: r.host, doc: r.doc as never })
    await r.generations[0]!.push(1)
    const late: number[] = []
    subscribePush(r.source, (n) => late.push(n), { host: r.host, doc: r.doc as never })
    expect(late).toEqual([])
  })

  it('falls back to a slow poll (>= 15 s) while the stream cannot be opened, and retries the stream afterwards', async () => {
    vi.useFakeTimers()
    try {
      const poll = vi.fn()
      let attempts = 0
      const source: PushSource<number> = {
        id: 'p', poll, pollMs: 1000, // clamped up to MIN_POLL_MS
        open() { attempts++; return { [Symbol.asyncIterator]: () => ({ next: () => Promise.reject(new Error('no gateway')) }) } },
      }
      const host = {}
      const off = subscribePush(source, () => {}, { host, doc: new FakeDoc() as never })
      await vi.advanceTimersByTimeAsync(10)
      expect(attempts).toBe(1)
      expect(poll).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(MIN_POLL_MS - 100)
      expect(poll).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(200)
      expect(attempts).toBe(2)
      expect(poll).toHaveBeenCalledTimes(2)
      off()
      await vi.advanceTimersByTimeAsync(MIN_POLL_MS * 3)
      expect(attempts).toBe(2)
    } finally { vi.useRealTimers() }
  })

  it('gives up for good when onError says the refusal is permanent', async () => {
    vi.useFakeTimers()
    try {
      let attempts = 0
      const source: PushSource<number> = {
        id: 'p', onError: () => false,
        open() { attempts++; return { [Symbol.asyncIterator]: () => ({ next: () => Promise.reject(new Error('403')) }) } },
      }
      subscribePush(source, () => {}, { host: {}, doc: new FakeDoc() as never })
      await vi.advanceTimersByTimeAsync(5 * 60_000)
      expect(attempts).toBe(1)
    } finally { vi.useRealTimers() }
  })
})

describe('createPushTransport', () => {
  const ctxWith = () => {
    let callback: ((scope: never) => void | (() => void)) | undefined
    const scope = (remote: unknown) => ({ remote, inject: (_deps: string[], cb: (s: never) => void) => { cb(scope(remote) as never) } })
    return { ctx: { inject: (_deps: string[], cb: typeof callback) => { callback = cb } }, provide: (remote: unknown) => callback!(scope(remote) as never) }
  }
  it('waits for ctx.remote, mounts the descriptors once and opens the stream through the namespace', async () => {
    const { ctx, provide } = ctxWith()
    const spec = { pkg: 'x', serviceKey: 'xSvc', namespace: 'xNs', streams: [{ method: 'feed', params: ['sessionId'] }] }
    const transport = createPushTransport(ctx as never, spec)
    const mounts: unknown[] = []
    const disposed = vi.fn()
    const remote = {
      $mount: (contribution: unknown) => { mounts.push(contribution); return Promise.resolve(disposed) },
      xNs: { feed: (_id: string) => ({ dispose: vi.fn(), async *[Symbol.asyncIterator]() { yield 'a'; yield 'b' } }) },
    }
    const abort = new AbortController()
    const seen: string[] = []
    const run = (async () => { for await (const v of transport.stream<string>('feed', ['s1'], abort.signal)) seen.push(v) })()
    await tick()
    expect(seen).toEqual([])
    provide(remote)
    await run
    expect(mounts).toHaveLength(1)
    expect(seen).toEqual(['a', 'b'])
  })

  it('builds strict-codec descriptors the client gateway accepts', () => {
    const c = pushContribution({ pkg: 'x', serviceKey: 's', namespace: 'n', streams: [{ method: 'm', params: ['a', 'b'] }] })
    const d = c.descriptors[0] as { mode: string; invocation: { kind: string }; parameters: { wire: string; codec: { mode: string } }[]; result: { mode: string } }
    expect(d).toMatchObject({ mode: 'stream', invocation: { kind: 'direct' }, result: { mode: 'src-json' } })
    expect(d.parameters.map((p) => [p.wire, p.codec.mode])).toEqual([['a', 'strict'], ['b', 'strict']])
  })
})

describe('host helpers', () => {
  it('registers a Typert-discoverable service with a stream marker', () => {
    let provided: { key: string; value: Record<string, unknown> } | undefined
    const ctx = { reflect: { provide: (key: string, value: unknown) => { provided = { key, value: value as never }; return () => {} } } }
    registerPushRemote({ ctx, serviceKey: 'svc', namespace: 'ns', streams: [{ method: 'feed', implementation: function feed(signal: AbortSignal) { return pushIterable(() => () => {}, signal) } as never }] })
    const svc = provided!.value
    expect(provided!.key).toBe('svc')
    expect((svc.typertRemote as { namespace: string; service: unknown }).namespace).toBe('ns')
    expect((svc.typertRemote as { service: unknown }).service).toBe(svc)
    const marker = (Object.getPrototypeOf(svc) as Record<string, { version: number; methods: { method: string; mode: string }[] }>)[REMOTE_METHOD_DESCRIPTOR]!
    expect(marker.version).toBe(1)
    expect(marker.methods).toEqual([{ method: 'feed', mode: 'stream', invocation: { kind: 'direct' } }])
    expect(Function.prototype.toString.call((svc as Record<string, unknown>).feed)).toContain('feed(signal)')
  })

  it('pushIterable yields the snapshot first, then updates, and unsubscribes when aborted', async () => {
    const listeners = new Set<(n: number) => void>()
    const abort = new AbortController()
    const it = pushIterable<number>((emit) => { listeners.add(emit); return () => { listeners.delete(emit) } }, abort.signal, () => [0])
    const out: number[] = []
    const reader = (async () => { for await (const n of it) out.push(n) })()
    await tick()
    for (const l of listeners) l(1)
    for (const l of listeners) l(2)
    await tick()
    abort.abort()
    await reader
    expect(out).toEqual([0, 1, 2])
    expect(listeners.size).toBe(0)
  })
})

describe('host helper without a gateway', () => {
  it('is a no-op on a context without reflect', () => {
    expect(() => registerPushRemote({ ctx: {} as never, serviceKey: 's', namespace: 'n', streams: [] })()).not.toThrow()
  })
})
