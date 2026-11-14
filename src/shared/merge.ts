// Merge rule shared by the Host store and the browser store, so both halves converge on the same list.
// Per comment id the newer `updatedAt` wins (a tie keeps the left side); a removed id stays removed.
import type { ReviewComment } from '../client/types.ts'

export interface SessionSnapshot {
  next: number
  items: ReviewComment[]
  /** Tombstones: ids deleted by the user, newest last. */
  removed: string[]
}

export const MAX_ITEMS = 500
export const MAX_TOMBSTONES = 300

export function emptySnapshot(): SessionSnapshot { return { next: 1, items: [], removed: [] } }

export function isComment(value: unknown): value is ReviewComment {
  const c = value as Partial<ReviewComment> | null
  return typeof c === 'object' && c !== null && typeof c.id === 'string' && c.id !== '' && typeof c.number === 'number'
    && typeof c.quote === 'string' && typeof c.body === 'string' && typeof c.target === 'object' && c.target !== null
    && typeof c.anchor === 'object' && c.anchor !== null && typeof c.updatedAt === 'number'
    && (c.status === 'open' || c.status === 'sent' || c.status === 'resolved')
}

/** Coerce untrusted JSON into a snapshot, dropping malformed entries. */
export function normalizeSnapshot(input: unknown): SessionSnapshot {
  const raw = (typeof input === 'object' && input !== null ? input : {}) as Partial<SessionSnapshot>
  const items = (Array.isArray(raw.items) ? raw.items : []).filter(isComment).slice(0, MAX_ITEMS * 2)
  const removed = (Array.isArray(raw.removed) ? raw.removed : []).filter((id): id is string => typeof id === 'string' && id !== '').slice(-MAX_TOMBSTONES)
  const highest = items.reduce((n, item) => Math.max(n, item.number), 0)
  const next = typeof raw.next === 'number' && Number.isFinite(raw.next) ? Math.max(raw.next, highest + 1) : highest + 1
  return { next, items, removed }
}

export function mergeSnapshots(left: SessionSnapshot, right: SessionSnapshot): SessionSnapshot {
  const removed = [...new Set([...left.removed, ...right.removed])].slice(-MAX_TOMBSTONES)
  const gone = new Set(removed)
  const byId = new Map<string, ReviewComment>()
  for (const item of [...left.items, ...right.items]) {
    if (gone.has(item.id)) continue
    const existing = byId.get(item.id)
    if (existing === undefined || item.updatedAt > existing.updatedAt) byId.set(item.id, item)
  }
  let items = [...byId.values()].sort((a, b) => a.number - b.number || a.createdAt - b.createdAt)
  if (items.length > MAX_ITEMS) {
    // Keep the newest; resolved and sent go first.
    const rank = (c: ReviewComment): number => (c.status === 'open' ? 1 : 0)
    items = [...items].sort((a, b) => rank(b) - rank(a) || b.updatedAt - a.updatedAt).slice(0, MAX_ITEMS).sort((a, b) => a.number - b.number)
  }
  const highest = items.reduce((n, item) => Math.max(n, item.number), 0)
  return { next: Math.max(left.next, right.next, highest + 1), items, removed }
}

export function sameSnapshot(a: SessionSnapshot, b: SessionSnapshot): boolean {
  return a.next === b.next && a.removed.length === b.removed.length && a.items.length === b.items.length
    && a.items.every((item, i) => item.id === b.items[i]!.id && item.updatedAt === b.items[i]!.updatedAt)
}
