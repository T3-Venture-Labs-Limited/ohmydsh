// Per-skill usage counts from session logs: `skill` tool calls and `/name` invocations. Read-only, cached.
export interface UsageStat { count: number; lastUsed: number; sessions: number }

interface EventLike { type?: string; time?: number; data?: Record<string, unknown> }

/** Extract skill names used in one session's events. Defensive against shape drift: unknown shapes yield no counts. */
export function countSkillEvents(events: readonly EventLike[]): Map<string, { count: number; last: number }> {
  const out = new Map<string, { count: number; last: number }>()
  const bump = (name: string, time: number): void => {
    const cur = out.get(name) ?? { count: 0, last: 0 }
    cur.count += 1
    cur.last = Math.max(cur.last, time)
    out.set(name, cur)
  }
  for (const event of events) {
    const time = typeof event.time === 'number' ? event.time : 0
    if (event.type === 'tool/call' && event.data?.name === 'skill' && typeof event.data.arguments === 'string') {
      try {
        const name = (JSON.parse(event.data.arguments) as { name?: unknown }).name
        if (typeof name === 'string' && name.length > 0) bump(name, time)
      } catch { /* malformed arguments */ }
    } else if (event.type === 'user/message') {
      const message = event.data as { source?: { kind?: unknown; name?: unknown }; message?: { source?: { kind?: unknown; name?: unknown } } } | undefined
      const source = message?.source ?? message?.message?.source
      if (source?.kind === 'skill-invocation' && typeof source.name === 'string') bump(source.name, time)
    }
  }
  return out
}

export interface SessionReader {
  listSessions(signal?: AbortSignal): Promise<{ header: { id: string; origin?: string }; live?: boolean }[]>
  readSession(id: never): Promise<{ events: readonly EventLike[] }>
}

export class UsageIndex {
  private cache: { at: number; stats: Record<string, UsageStat>; sessionsScanned: number } | undefined
  private inflight: Promise<void> | undefined
  constructor(private readonly ttlMs = 120_000) {}

  invalidate(): void { this.cache = undefined }

  /** Cached stats without triggering a scan. */
  peek(): { stats: Record<string, UsageStat>; sessionsScanned: number } | undefined { return this.cache }

  async get(reader: SessionReader | undefined, force = false, now = Date.now()): Promise<{ stats: Record<string, UsageStat>; sessionsScanned: number; available: boolean }> {
    if (reader === undefined || typeof reader.listSessions !== 'function' || typeof reader.readSession !== 'function') return { stats: {}, sessionsScanned: 0, available: false }
    if (!force && this.cache !== undefined && now - this.cache.at < this.ttlMs) return { ...this.cache, available: true }
    this.inflight ??= this.refresh(reader).finally(() => { this.inflight = undefined })
    await this.inflight
    return { ...(this.cache ?? { stats: {}, sessionsScanned: 0 }), available: true }
  }

  private async refresh(reader: SessionReader): Promise<void> {
    const records = await reader.listSessions()
    const stats: Record<string, UsageStat> = {}
    let scanned = 0
    const queue = [...records]
    const worker = async (): Promise<void> => {
      for (let record = queue.shift(); record !== undefined; record = queue.shift()) {
        try {
          const snap = await reader.readSession(record.header.id as never)
          scanned += 1
          for (const [name, v] of countSkillEvents(snap.events)) {
            const s = stats[name] ?? { count: 0, lastUsed: 0, sessions: 0 }
            s.count += v.count
            s.lastUsed = Math.max(s.lastUsed, v.last)
            s.sessions += 1
            stats[name] = s
          }
        } catch { /* unreadable or migrating session */ }
      }
    }
    await Promise.all([worker(), worker(), worker()])
    this.cache = { at: Date.now(), stats, sessionsScanned: scanned }
  }
}
