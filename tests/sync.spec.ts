import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { startHostSync, syncStatus } from '../src/client/hostSync.ts'
import { createCommentStore } from '../src/client/store.ts'
import { HostStore } from '../src/host/store.ts'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { NewComment } from '../src/client/types.ts'

const draft = (body: string): NewComment => ({ sessionId: 's1', target: { kind: 'message', role: 'assistant' }, anchor: { kind: 'message', nodeKey: 'k' }, quote: 'q', find: 'q', prefix: '', suffix: '', occurrence: 0, body })
const mem = () => { const d = new Map<string, string>(); return { getItem: (k: string) => d.get(k) ?? null, setItem: (k: string, v: string) => { d.set(k, v) }, removeItem: (k: string) => { d.delete(k) } } }

let dir = ''
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'drc-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })
const fast = { debounceMs: 5 }
const settle = async (check: () => Promise<void> | void): Promise<void> => { await vi.waitFor(check, { timeout: 2000, interval: 10 }) }

/** A fetch that talks to a real HostStore, like the /sync route does. */
const hostFetch = (host: HostStore) => (async (_url: string, init?: RequestInit) => {
  const body = JSON.parse(String(init?.body)) as { sessionId: string; snapshot?: unknown }
  const snapshot = body.snapshot === undefined ? await host.get(body.sessionId) : await host.merge(body.sessionId, body.snapshot)
  return { ok: true, json: async () => ({ ok: true, snapshot }) }
}) as unknown as typeof fetch

describe('host sync', () => {
  it('pushes local edits after a debounce and pulls agent changes back', async () => {
    const host = new HostStore(dir)
    const store = createCommentStore(mem())
    const sync = startHostSync(store, { fetch: hostFetch(host), ...fast })
    const first = store.add(draft('one'))
    store.add(draft('two'))
    await settle(async () => { expect((await host.get('s1')).items).toHaveLength(2) })
    // The agent resolves RC-1 on the Host; the page re-syncs when told.
    await host.resolve('s1', [first.number], 'done')
    await sync.syncNow('s1')
    expect(store.get('s1', first.id)).toMatchObject({ status: 'resolved', resolvedBy: 'agent', resolution: 'done' })
    sync.dispose(); store.dispose()
  })
  it('a fresh browser recovers comments from the Host', async () => {
    const host = new HostStore(dir)
    await host.merge('s1', { next: 2, items: [{ ...draft('kept'), id: 'x', number: 1, status: 'open', createdAt: 1, updatedAt: 1 } as never], removed: [] })
    const store = createCommentStore(mem())
    const sync = startHostSync(store, { fetch: hostFetch(host), ...fast })
    store.list('s1') // first read triggers a load
    await settle(() => { expect(store.list('s1').map(i => i.body)).toEqual(['kept']) })
    sync.dispose(); store.dispose()
  })
  it('keeps working locally when the Host is unreachable and retries on the next edit', async () => {
    const store = createCommentStore(mem())
    let fail = true; const host = new HostStore(dir)
    const sync = startHostSync(store, { ...fast, fetch: (async (...a: Parameters<typeof fetch>) => { if (fail) throw new Error('down'); return hostFetch(host)(...a) }) as typeof fetch })
    store.add(draft('offline'))
    await settle(() => { expect(sync.online()).toBe(false) })
    expect(store.list('s1')).toHaveLength(1)
    fail = false
    store.add(draft('back'))
    await settle(async () => { expect((await host.get('s1')).items.map(i => i.body)).toEqual(['offline', 'back']) })
    expect(sync.online()).toBe(true)
    sync.dispose(); store.dispose()
  })
  it('a delete on the page is not resurrected by the Host copy', async () => {
    const host = new HostStore(dir)
    const store = createCommentStore(mem())
    const sync = startHostSync(store, { fetch: hostFetch(host), ...fast })
    const c = store.add(draft('gone'))
    await settle(async () => { expect((await host.get('s1')).items).toHaveLength(1) })
    store.remove('s1', c.id)
    await settle(async () => { expect((await host.get('s1')).items).toEqual([]) })
    expect(store.list('s1')).toEqual([])
    sync.dispose(); store.dispose()
  })
  it('shows the Host copy as full on 413 and clears it after a successful sync', async () => {
    const store = createCommentStore(mem())
    let full = true; const host = new HostStore(dir)
    const sync = startHostSync(store, { ...fast, fetch: (async (...a: Parameters<typeof fetch>) => full ? ({ ok: false, status: 413, json: async () => ({ ok: false, error: 'too-large' }) }) : hostFetch(host)(...a)) as unknown as typeof fetch })
    store.add(draft('big'))
    await settle(() => { expect(syncStatus.isFull('s1')).toBe(true) })
    expect(store.list('s1')).toHaveLength(1)
    full = false
    store.add(draft('smaller'))
    await settle(() => { expect(syncStatus.isFull('s1')).toBe(false) })
    sync.dispose(); store.dispose()
  })
})

describe('host sync push stream', () => {
  class Doc {
    visibilityState: 'visible' | 'hidden' = 'visible'
    private hs = new Set<() => void>()
    addEventListener(_t: string, h: () => void) { this.hs.add(h) }
    removeEventListener(_t: string, h: () => void) { this.hs.delete(h) }
    set(v: 'visible' | 'hidden') { this.visibilityState = v; for (const h of this.hs) h() }
  }
  /** A controllable stream: each `open` is one generation. */
  function streams() {
    const gens: { signal: AbortSignal; push(item: unknown): Promise<void> }[] = []
    const open = (signal: AbortSignal): AsyncIterable<unknown> => {
      const items: unknown[] = []; let wake: (() => void) | undefined
      gens.push({ signal, async push(item) { items.push(item); wake?.(); await new Promise((r) => setTimeout(r, 0)) } })
      signal.addEventListener('abort', () => wake?.(), { once: true })
      return { [Symbol.asyncIterator]: async function* () {
        while (!signal.aborted) { if (items.length > 0) { yield items.shift(); continue } await new Promise<void>((r) => { wake = r }) }
      } }
    }
    return { gens, open }
  }

  it('pulls when the Host announces a change, holds no stream while hidden and resyncs on resume', async () => {
    const host = new HostStore(dir)
    const store = createCommentStore(mem())
    const doc = new Doc(); const s = streams()
    const sync = startHostSync(store, { fetch: hostFetch(host), ...fast, open: s.open, push: { host: {}, doc: doc as never } })
    const c = store.add(draft('one'))
    await settle(async () => { expect((await host.get('s1')).items).toHaveLength(1) })
    expect(s.gens).toHaveLength(1)
    await host.resolve('s1', [c.number], 'done')
    await s.gens[0]!.push({ sessionId: 's1' })
    await settle(() => { expect(store.get('s1', c.id)).toMatchObject({ status: 'resolved', resolvedBy: 'agent' }) })
    // hidden: the connection is released
    doc.set('hidden')
    expect(s.gens[0]!.signal.aborted).toBe(true)
    // a change while hidden is picked up when the page returns (resync of the sessions we know)
    await host.resolve('s1', [], 'noop')
    doc.set('visible')
    expect(s.gens).toHaveLength(2)
    sync.dispose(); store.dispose()
    expect(s.gens[1]!.signal.aborted).toBe(true)
  })

  it('two syncs on one page (the plugin mounted twice) share one stream', async () => {
    const host = new HostStore(dir)
    const doc = new Doc(); const s = streams(); const pushHost = {}
    const a = startHostSync(createCommentStore(mem()), { fetch: hostFetch(host), ...fast, open: s.open, push: { host: pushHost, doc: doc as never } })
    const b = startHostSync(createCommentStore(mem()), { fetch: hostFetch(host), ...fast, open: s.open, push: { host: pushHost, doc: doc as never } })
    expect(s.gens).toHaveLength(1)
    a.dispose()
    expect(s.gens[0]!.signal.aborted).toBe(false)
    b.dispose()
    expect(s.gens[0]!.signal.aborted).toBe(true)
  })
})
