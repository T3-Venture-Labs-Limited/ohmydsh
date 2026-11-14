// Per-session comment files under `$DSH_HOME/review-comments/`, written atomically (0600) and serialized per session.
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ReviewComment } from '../client/types.ts'
import { emptySnapshot, mergeSnapshots, normalizeSnapshot, type SessionSnapshot } from '../shared/merge.ts'

export const SESSION_ID = /^[A-Za-z0-9_.-]{1,128}$/
/** Largest session file the Host will persist (2 MB). */
export const MAX_FILE_BYTES = 2 * 1024 * 1024

export class TooLargeError extends Error {
  constructor(readonly bytes: number, readonly limit: number) { super(`session file would be ${String(bytes)} bytes, over the ${String(limit)} byte limit`) }
}

export class HostStore {
  private readonly cache = new Map<string, SessionSnapshot>()
  private readonly writing = new Map<string, Promise<void>>()
  private readonly listeners = new Set<(sessionId: string) => void>()

  constructor(readonly dir: string, private readonly now: () => number = Date.now, readonly maxBytes: number = MAX_FILE_BYTES) {}

  subscribe(listener: (sessionId: string) => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }

  private file(sessionId: string): string { return join(this.dir, `${sessionId}.json`) }

  async get(sessionId: string): Promise<SessionSnapshot> {
    this.assert(sessionId)
    const hit = this.cache.get(sessionId)
    if (hit !== undefined) return hit
    let snapshot = emptySnapshot()
    try { snapshot = normalizeSnapshot(JSON.parse(await readFile(this.file(sessionId), 'utf8'))) } catch { /* missing or corrupt file: start empty */ }
    // Another call may have loaded it meanwhile.
    return this.cache.get(sessionId) ?? (this.cache.set(sessionId, snapshot), snapshot)
  }

  /** Merge an incoming browser snapshot and persist. Returns the merged result. */
  async merge(sessionId: string, incoming: unknown): Promise<SessionSnapshot> {
    const current = await this.get(sessionId)
    const merged = mergeSnapshots(current, normalizeSnapshot(incoming))
    // Refuse growth past the cap; the page keeps its own copy and says so. Shrinking (deleting or resolving) is always accepted.
    const bytes = Buffer.byteLength(JSON.stringify(merged))
    if (bytes > this.maxBytes && bytes > Buffer.byteLength(JSON.stringify(current))) throw new TooLargeError(bytes, this.maxBytes)
    return this.commit(sessionId, current, merged)
  }

  /** Apply a change from the agent tool. Resolves by comment number; unknown numbers are reported, not fatal. */
  async resolve(sessionId: string, numbers: readonly number[], note: string | undefined): Promise<{ resolved: number[]; missing: number[]; already: number[] }> {
    const current = await this.get(sessionId)
    const wanted = new Set(numbers)
    const resolved: number[] = []
    const already: number[] = []
    const at = this.now()
    const items: ReviewComment[] = current.items.map(item => {
      if (!wanted.has(item.number)) return item
      if (item.status === 'resolved') { already.push(item.number); return item }
      resolved.push(item.number)
      const { resolution: _drop, ...rest } = item
      return { ...rest, status: 'resolved' as const, resolvedBy: 'agent' as const, ...(note === undefined || note === '' ? {} : { resolution: note.slice(0, 500) }), updatedAt: Math.max(at, item.updatedAt + 1) }
    })
    const known = new Set(current.items.map(item => item.number))
    const missing = numbers.filter(n => !known.has(n))
    if (resolved.length > 0) await this.commit(sessionId, current, { ...current, items })
    return { resolved, missing, already }
  }

  private async commit(sessionId: string, before: SessionSnapshot, next: SessionSnapshot): Promise<SessionSnapshot> {
    const changed = JSON.stringify(before) !== JSON.stringify(next)
    this.cache.set(sessionId, next)
    if (changed) {
      const text = JSON.stringify(next)
      const write = (this.writing.get(sessionId) ?? Promise.resolve()).then(async () => {
        await mkdir(this.dir, { recursive: true, mode: 0o700 })
        const tmp = `${this.file(sessionId)}.${String(process.pid)}.tmp`
        await writeFile(tmp, text, { mode: 0o600 })
        await rename(tmp, this.file(sessionId))
      })
      this.writing.set(sessionId, write.catch(() => undefined))
      await write
      for (const listener of [...this.listeners]) listener(sessionId)
    }
    return next
  }

  private assert(sessionId: string): void { if (!SESSION_ID.test(sessionId)) throw new Error('invalid session id') }
}
