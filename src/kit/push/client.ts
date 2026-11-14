// Stream lifecycle of the push channel. One shared stream per id per page (window-level registry, so a plugin mounted twice
// still opens one), opened only while at least one consumer is mounted AND the page is visible, closed the moment either
// stops being true, and backed by a slow poll (>= 15 s) while the stream cannot be opened. The transport that actually
// opens the stream (DSH's multiplexed WebSocket) is in ./transport.ts.

export interface PushSource<T> {
  /** Registry key: one shared stream per id per page. */
  readonly id: string
  /** Open the stream; must end when `signal` aborts. */
  open(signal: AbortSignal): AsyncIterable<T>
  /** Fetch the current state once. Used as the slow fallback while the stream cannot be opened. */
  poll?(): Promise<void> | void
  /** Fallback poll period, clamped to >= 15 000 ms. */
  readonly pollMs?: number
  /** Called each time the stream (re)opens so a consumer can resync what it may have missed while closed. */
  readonly onOpen?: () => void
  /** Replay the last item to a subscriber that joins an already-open stream. Default true; turn off for event/delta streams. */
  readonly replay?: boolean
  /** Called when a stream generation ends or is closed (hidden page, last consumer gone, drop). */
  readonly onClose?: () => void
  /** Called when opening/reading failed. Return `false` to give up for good (a permanent refusal); otherwise it is retried. */
  readonly onError?: (error: unknown, attempt: number) => Promise<boolean | void> | boolean | void
  /** Retry pause after the n-th consecutive failure when no `poll` is set. Default 1 s doubling up to 60 s. */
  readonly backoffMs?: (attempt: number) => number
}

export interface PushEnv {
  readonly doc?: Pick<Document, 'visibilityState' | 'addEventListener' | 'removeEventListener'> | undefined
  /** Window-like object holding the registry; defaults to globalThis. */
  readonly host?: object | undefined
  readonly setTimeout?: typeof setTimeout
  readonly clearTimeout?: typeof clearTimeout
}

export const MIN_POLL_MS = 15_000
const MAX_BACKOFF_MS = 60_000
const REGISTRY = '__dshPushStreams'

interface Entry<T> {
  source: PushSource<T>
  readonly listeners: Set<(item: T) => void>
  abort: AbortController | undefined
  last: { value: T } | undefined
  readonly env: Required<Pick<PushEnv, 'setTimeout' | 'clearTimeout'>> & PushEnv
  readonly sync: () => void
  readonly off: () => void
}

type Registry = Map<string, Entry<never>>

function registryOf(host: object): Registry {
  const bag = host as Record<string, Registry | undefined>
  return bag[REGISTRY] ??= new Map()
}

/** Number of live streams in a registry (for tests and diagnostics). */
export function openPushStreams(host: object = globalThis): number {
  let n = 0
  for (const entry of registryOf(host).values()) if (entry.abort !== undefined) n++
  return n
}

/**
 * Subscribe to a plugin's push source. The first subscriber for an id creates the shared entry; later ones join it
 * (a second mount of the same plugin never opens a second stream) and immediately receive the last item.
 * @returns the disposer; the stream closes when the last subscriber leaves or the page is hidden.
 */
export function subscribePush<T>(source: PushSource<T>, listener: (item: T) => void, env: PushEnv = {}): () => void {
  const host = env.host ?? globalThis
  const registry = registryOf(host)
  let entry = registry.get(source.id) as Entry<T> | undefined
  if (entry === undefined) entry = create(source, env, host, registry)
  const joined = entry
  joined.source = source // the newest mount's callbacks win; the stream itself stays shared
  joined.listeners.add(listener)
  if (joined.last !== undefined && source.replay !== false) listener(joined.last.value)
  joined.sync()
  let released = false
  return () => {
    if (released) return
    released = true
    joined.listeners.delete(listener)
    if (joined.listeners.size === 0) { close(joined); joined.off(); if (registry.get(source.id) === (joined as unknown as Entry<never>)) registry.delete(source.id) }
  }
}

function create<T>(source: PushSource<T>, env: PushEnv, host: object, registry: Registry): Entry<T> {
  const doc = env.doc === undefined && typeof document !== 'undefined' ? document : env.doc
  const timers = { setTimeout: env.setTimeout ?? setTimeout, clearTimeout: env.clearTimeout ?? clearTimeout }
  const entry: Entry<T> = {
    source, listeners: new Set(), abort: undefined, last: undefined,
    env: { ...env, ...timers, doc, host },
    sync: () => {
      const wanted = entry.listeners.size > 0 && (doc === undefined || doc.visibilityState === 'visible')
      if (wanted && entry.abort === undefined) start(entry)
      else if (!wanted && entry.abort !== undefined) close(entry)
    },
    off: () => { doc?.removeEventListener('visibilitychange', entry.sync) },
  }
  doc?.addEventListener('visibilitychange', entry.sync)
  registry.set(source.id, entry as unknown as Entry<never>)
  return entry
}

function close<T>(entry: Entry<T>): void {
  entry.abort?.abort()
  entry.abort = undefined
}

function start<T>(entry: Entry<T>): void {
  const abort = new AbortController()
  entry.abort = abort
  const { signal } = abort
  const { setTimeout: later, clearTimeout: cancel } = entry.env
  const wait = (ms: number): Promise<void> => new Promise((resolve) => {
    const timer = later(done, ms)
    function done(): void { signal.removeEventListener('abort', done); cancel(timer); resolve() }
    signal.addEventListener('abort', done, { once: true })
  })
  void (async () => {
    let attempt = 0
    while (!signal.aborted) {
      const source = entry.source
      let opened = false
      let failure: unknown
      try {
        for await (const item of source.open(signal)) {
          if (signal.aborted) return
          if (!opened) { opened = true; attempt = 0; try { entry.source.onOpen?.() } catch { /* a consumer fault must not kill the stream */ } }
          entry.last = { value: item }
          for (const l of entry.listeners) { try { l(item) } catch { /* isolate listeners */ } }
        }
      } catch (error) { failure = error }
      try { entry.source.onClose?.() } catch { /* ignore */ }
      if (signal.aborted) return
      attempt++
      if (failure !== undefined) {
        try { if (await entry.source.onError?.(failure, attempt) === false) return } catch { /* keep retrying */ }
        if (signal.aborted) return
      }
      // Stream unavailable or dropped: keep the page fresh with a slow poll, retry the stream after the same pause.
      let delay = entry.source.backoffMs?.(attempt) ?? Math.min(MAX_BACKOFF_MS, 1000 * 2 ** Math.min(attempt, 6))
      if (entry.source.poll !== undefined) {
        delay = Math.max(MIN_POLL_MS, entry.source.pollMs ?? MIN_POLL_MS)
        try { await entry.source.poll() } catch { /* next round */ }
      }
      await wait(delay)
    }
  })()
}

