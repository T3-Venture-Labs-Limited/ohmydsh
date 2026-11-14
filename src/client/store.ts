// Per-session comment store: localStorage v1 with an in-memory fallback, plus a version counter for
// useSyncExternalStore. The Host keeps the durable copy (see ./hostSync.ts); both sides use the same merge rule.
import type { CommentStatus, NewComment, ReviewComment } from './types.ts'
import { emptySnapshot, mergeSnapshots, normalizeSnapshot, sameSnapshot, MAX_ITEMS, MAX_TOMBSTONES, type SessionSnapshot } from '../shared/merge.ts'

const PREFIX = 'dsh-review-comments:v1:'

export interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

export interface CommentStore {
  list(sessionId: string): readonly ReviewComment[]
  get(sessionId: string, id: string): ReviewComment | undefined
  add(input: NewComment): ReviewComment
  update(sessionId: string, id: string, patch: Partial<Pick<ReviewComment, 'body' | 'status' | 'anchor'>>): void
  setStatus(sessionId: string, ids: readonly string[], status: CommentStatus): void
  remove(sessionId: string, id: string): void
  removeWhere(sessionId: string, predicate: (comment: ReviewComment) => boolean): void
  /** True when persisting failed and the session lives only in memory. */
  memoryOnly(sessionId: string): boolean
  /** The full per-session snapshot (items, counter, tombstones) for the Host sync. */
  snapshot(sessionId: string): SessionSnapshot
  /** Merge a snapshot that came from the Host. Does not notify `onLocalChange`. */
  mergeRemote(sessionId: string, remote: SessionSnapshot): void
  /** Called after every local mutation and the first time a session is read. */
  onLocalChange(listener: (sessionId: string, reason: 'load' | 'change') => void): () => void
  getSnapshot(): number
  subscribe(listener: () => void): () => void
  dispose(): void
}

function defaultStorage(): StorageLike | undefined {
  try { return typeof localStorage === 'undefined' ? undefined : localStorage } catch { return undefined }
}

export function createCommentStore(storage: StorageLike | undefined = defaultStorage(), now: () => number = Date.now): CommentStore {
  const sessions = new Map<string, SessionSnapshot>()
  const memory = new Set<string>()
  const listeners = new Set<() => void>()
  const localListeners = new Set<(sessionId: string, reason: 'load' | 'change') => void>()
  let version = 0

  const load = (sessionId: string): SessionSnapshot => {
    let record = sessions.get(sessionId)
    if (record === undefined) {
      let raw: string | null = null
      try { raw = storage?.getItem(PREFIX + sessionId) ?? null } catch { memory.add(sessionId) }
      try { record = raw === null ? emptySnapshot() : normalizeSnapshot(JSON.parse(raw)) } catch { record = emptySnapshot() }
      sessions.set(sessionId, record)
      for (const listener of [...localListeners]) listener(sessionId, 'load')
    }
    return record
  }
  const persist = (sessionId: string, record: SessionSnapshot): void => {
    try {
      if (storage === undefined) memory.add(sessionId)
      else if (record.items.length === 0 && record.removed.length === 0) storage.removeItem(PREFIX + sessionId)
      else storage.setItem(PREFIX + sessionId, JSON.stringify(record))
    } catch { memory.add(sessionId) }
  }
  const notify = (): void => { version += 1; for (const listener of [...listeners]) listener() }
  const commit = (sessionId: string, record: SessionSnapshot, local = true): void => {
    sessions.set(sessionId, record)
    persist(sessionId, record)
    notify()
    if (local) for (const listener of [...localListeners]) listener(sessionId, 'change')
  }
  const touch = (item: ReviewComment): ReviewComment => ({ ...item, updatedAt: Math.max(now(), item.updatedAt + 1) })
  const onStorage = (event: StorageEvent): void => {
    if (event.key === null || !event.key.startsWith(PREFIX)) return
    sessions.delete(event.key.slice(PREFIX.length))
    notify()
  }
  if (typeof window !== 'undefined') window.addEventListener('storage', onStorage)

  const id = (): string => `${now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
  const withRemoved = (record: SessionSnapshot, gone: readonly string[]): string[] => [...record.removed, ...gone].slice(-MAX_TOMBSTONES)

  return {
    list: sessionId => load(sessionId).items,
    get: (sessionId, commentId) => load(sessionId).items.find(item => item.id === commentId),
    add(input) {
      const record = load(input.sessionId)
      const at = now()
      const comment: ReviewComment = { ...input, id: id(), number: record.next, status: 'open', createdAt: at, updatedAt: at }
      let items = [...record.items, comment]
      let gone: string[] = []
      if (items.length > MAX_ITEMS) {
        const drop = items.find(item => item.status !== 'open') ?? items[0]!
        gone = [drop.id]
        items = items.filter(item => item !== drop)
      }
      commit(input.sessionId, { next: record.next + 1, items, removed: withRemoved(record, gone) })
      return comment
    },
    update(sessionId, commentId, patch) {
      const record = load(sessionId)
      commit(sessionId, { ...record, items: record.items.map(item => {
        if (item.id !== commentId) return item
        const next = touch({ ...item, ...patch })
        // Reopening or re-sending a comment clears who resolved it.
        if (patch.status !== undefined && patch.status !== 'resolved') { delete next.resolvedBy; delete next.resolution }
        if (patch.status === 'resolved') { next.resolvedBy = 'user'; delete next.resolution }
        return next
      }) })
    },
    setStatus(sessionId, ids, status) {
      const record = load(sessionId)
      const set = new Set(ids)
      commit(sessionId, { ...record, items: record.items.map(item => {
        if (!set.has(item.id)) return item
        const next = touch({ ...item, status })
        if (status === 'resolved') { next.resolvedBy = 'user'; delete next.resolution } else { delete next.resolvedBy; delete next.resolution }
        return next
      }) })
    },
    remove(sessionId, commentId) {
      const record = load(sessionId)
      commit(sessionId, { ...record, items: record.items.filter(item => item.id !== commentId), removed: withRemoved(record, [commentId]) })
    },
    removeWhere(sessionId, predicate) {
      const record = load(sessionId)
      const gone = record.items.filter(predicate).map(item => item.id)
      if (gone.length === 0) return
      commit(sessionId, { ...record, items: record.items.filter(item => !gone.includes(item.id)), removed: withRemoved(record, gone) })
    },
    memoryOnly: sessionId => memory.has(sessionId),
    snapshot: sessionId => load(sessionId),
    mergeRemote(sessionId, remote) {
      const current = load(sessionId)
      const merged = mergeSnapshots(current, normalizeSnapshot(remote))
      if (!sameSnapshot(current, merged)) commit(sessionId, merged, false)
    },
    onLocalChange(listener) { localListeners.add(listener); return () => { localListeners.delete(listener) } },
    getSnapshot: () => version,
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener) } },
    dispose() {
      listeners.clear(); localListeners.clear()
      if (typeof window !== 'undefined') window.removeEventListener('storage', onStorage)
    },
  }
}
