// Browser <-> Host sync. The browser store stays the instant, offline-capable source for the UI; the Host keeps a durable
// copy (survives clearing browser storage, readable by the agent tool). Pushes are debounced and driven by local edits;
// pulls are driven by the Host's push stream (a Typert stream on DSH's shared WebSocket, open only while the page is
// visible) when an agent changes a comment. While that stream cannot be opened a slow (>= 15 s) poll re-syncs instead.
import type { CommentStore } from './store.ts'
import { normalizeSnapshot } from '../shared/merge.ts'
import { subscribePush } from '../kit/push/client.ts'
import type { PushEnv } from '../kit/push/client.ts'

const API = 'api/review-comments'
const DEBOUNCE_MS = 350

export interface HostSyncDeps {
  fetch: typeof fetch
  /** Open the Host change stream (items are `{ sessionId }`); it must end when the signal aborts. Omit for no live channel. */
  open?: (signal: AbortSignal) => AsyncIterable<unknown>
  /** Test seam: registry host, document and timers of the shared push stream. */
  push?: PushEnv
  /** Debounce for pushes after a local edit (default 350 ms). */
  debounceMs?: number
}

export interface HostSync { dispose(): void; syncNow(sessionId: string): Promise<boolean>; online(): boolean; full(sessionId: string): boolean }

/** Sessions whose Host copy refused a push for size. Read by the UI. */
const fullSessions = new Set<string>()
const fullListeners = new Set<() => void>()
let fullVersion = 0
export const syncStatus = {
  isFull: (sessionId: string): boolean => fullSessions.has(sessionId),
  getSnapshot: (): number => fullVersion,
  subscribe(listener: () => void): () => void { fullListeners.add(listener); return () => { fullListeners.delete(listener) } },
}
function setFull(sessionId: string, full: boolean): void {
  if (fullSessions.has(sessionId) === full) return
  if (full) fullSessions.add(sessionId); else fullSessions.delete(sessionId)
  fullVersion += 1
  for (const listener of [...fullListeners]) listener()
}

export const STREAM_ID = 'dsh-review-comments:changes'
export const FALLBACK_POLL_MS = 15_000

export function startHostSync(store: CommentStore, deps: HostSyncDeps = { fetch: globalThis.fetch.bind(globalThis) }): HostSync {
  const timers = new Map<string, ReturnType<typeof setTimeout>>()
  const inflight = new Set<string>()
  const queued = new Set<string>()
  let alive = true
  let reachable = true

  const syncNow = async (sessionId: string): Promise<boolean> => {
    if (!alive) return false
    if (inflight.has(sessionId)) { queued.add(sessionId); return false }
    inflight.add(sessionId)
    try {
      const response = await deps.fetch(`${API}/sync`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId, snapshot: store.snapshot(sessionId) }),
      })
      const body = await response.json() as { ok?: boolean; snapshot?: unknown; error?: string }
      if (response.status === 413 || body.error === 'too-large') { reachable = true; setFull(sessionId, true); return false }
      if (!response.ok || body.ok !== true) { reachable = false; return false }
      reachable = true
      setFull(sessionId, false)
      if (alive) store.mergeRemote(sessionId, normalizeSnapshot(body.snapshot))
      return true
    } catch {
      reachable = false
      return false
    } finally {
      inflight.delete(sessionId)
      if (queued.delete(sessionId) && alive) schedule(sessionId)
    }
  }

  const schedule = (sessionId: string): void => {
    if (!alive) return
    const existing = timers.get(sessionId)
    if (existing !== undefined) clearTimeout(existing)
    timers.set(sessionId, setTimeout(() => { timers.delete(sessionId); void syncNow(sessionId) }, deps.debounceMs ?? DEBOUNCE_MS))
  }

  const offLocal = store.onLocalChange(sessionId => { schedule(sessionId) })

  const known = new Set<string>()
  const knownSessions = (): string[] => [...known]
  const offSeen = store.onLocalChange(sessionId => { known.add(sessionId) })

  // Host-side changes (an agent resolved a comment) arrive here. One shared stream per page, closed while hidden.
  let offStream: (() => void) | undefined
  if (deps.open !== undefined) {
    offStream = subscribePush<unknown>({
      id: STREAM_ID,
      replay: false,
      open: deps.open,
      // After a (re)open, or while the stream is unavailable, re-sync what we hold: nothing may have been missed.
      onOpen: () => { for (const sessionId of knownSessions()) schedule(sessionId) },
      poll: () => { for (const sessionId of knownSessions()) schedule(sessionId) },
      pollMs: FALLBACK_POLL_MS,
    }, (item) => {
      const sessionId = (item as { sessionId?: unknown } | null)?.sessionId
      if (typeof sessionId === 'string') void syncNow(sessionId)
    }, deps.push)
  }

  // Back on screen after a failed attempt: retry once.
  const onVisible = (): void => { if (!reachable && !document.hidden) for (const sessionId of knownSessions()) schedule(sessionId) }
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisible)

  return {
    syncNow,
    online: () => reachable,
    full: sessionId => fullSessions.has(sessionId),
    dispose() {
      alive = false
      fullSessions.clear(); fullVersion += 1
      offLocal(); offSeen(); offStream?.()
      for (const timer of timers.values()) clearTimeout(timer)
      timers.clear()
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisible)
    },
  }
}
