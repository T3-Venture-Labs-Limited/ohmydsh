/**
 * Storage under `$DSH_HOME/triggers/` (all files 0600, directory 0700):
 *  - automations.json  `{ version: 1, paused, automations }` (atomic write)
 *  - secrets.json      `{ [automationId]: secret }` (atomic write)
 *  - runs.jsonl        append-only RunRow lines; several lines may share a runId, the latest wins
 *  - seen.json         dedupe ids (last 2000) + per-automation known files (baseline + fired, bounded)
 *  - queue.json        reuse-mode deliveries waiting for a busy chat
 * No payload content is written to the run log.
 */
import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { GLOBAL_MAX_PER_HOUR, type Automation, type RunRow } from '../shared/types.ts'

export const MAX_RUNS = 2000
export const MAX_SEEN_IDS = 2000
export const MAX_KNOWN_FILES = 20_000

export interface Data { version: 1; paused: boolean; automations: Automation[] }
export interface QueuedDelivery { runId: string; sessionId: string; text: string; at: number }
interface Seen { ids: string[]; files: Record<string, string[]>; baselines?: Record<string, string> }

/** Serialised atomic JSON writer (tmp + rename, 0600). */
export class JsonFile<T> {
  private writing: Promise<void> = Promise.resolve()
  constructor(readonly path: string) {}
  async read(): Promise<T | undefined> {
    try { return JSON.parse(await readFile(this.path, 'utf8')) as T } catch { return undefined }
  }
  write(value: T): Promise<void> {
    const snapshot = JSON.stringify(value, null, 1)
    const next = this.writing.then(async () => {
      const tmp = `${this.path}.${String(process.pid)}.tmp`
      await writeFile(tmp, snapshot, { mode: 0o600 })
      await rename(tmp, this.path)
    })
    this.writing = next.catch(() => {})
    return next
  }
  flushed(): Promise<void> { return this.writing }
}

const COUNTED: ReadonlySet<string> = new Set(['pending', 'queued', 'delivered'])

export class TriggersStore {
  data: Data = { version: 1, paused: false, automations: [] }
  secrets: Record<string, string> = {}
  queue: Record<string, QueuedDelivery[]> = {}
  /** runId -> latest row, insertion order = first seen (oldest first). */
  private readonly runs = new Map<string, RunRow>()
  private readonly seenIds = new Set<string>()
  private readonly known = new Map<string, Set<string>>()
  private baselines: Record<string, string> = {}
  private readonly files: { data: JsonFile<Data>; secrets: JsonFile<Record<string, string>>; seen: JsonFile<Seen>; queue: JsonFile<Record<string, QueuedDelivery[]>> }
  private seenTimer: ReturnType<typeof setTimeout> | undefined
  loaded = false

  constructor(readonly dir: string) {
    this.files = {
      data: new JsonFile(join(dir, 'automations.json')),
      secrets: new JsonFile(join(dir, 'secrets.json')),
      seen: new JsonFile(join(dir, 'seen.json')),
      queue: new JsonFile(join(dir, 'queue.json')),
    }
  }

  get runsPath(): string { return join(this.dir, 'runs.jsonl') }

  async load(): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 })
    const data = await this.files.data.read()
    if (data?.version === 1 && Array.isArray(data.automations)) this.data = { version: 1, paused: data.paused === true, automations: data.automations }
    const secrets = await this.files.secrets.read()
    if (typeof secrets === 'object' && secrets !== null) this.secrets = Object.fromEntries(Object.entries(secrets).filter((e): e is [string, string] => typeof e[1] === 'string'))
    const seen = await this.files.seen.read()
    for (const id of Array.isArray(seen?.ids) ? seen.ids.slice(-MAX_SEEN_IDS) : []) if (typeof id === 'string') this.seenIds.add(id)
    for (const [k, v] of Object.entries(seen?.files ?? {})) if (Array.isArray(v)) this.known.set(k, new Set(v.filter((x) => typeof x === 'string')))
    if (typeof seen?.baselines === 'object' && seen.baselines !== null) this.baselines = { ...seen.baselines }
    const queue = await this.files.queue.read()
    if (typeof queue === 'object' && queue !== null) this.queue = Object.fromEntries(Object.entries(queue).filter((e) => Array.isArray(e[1])))
    try {
      const lines = (await readFile(this.runsPath, 'utf8')).split('\n').filter((l) => l !== '')
      for (const line of lines.slice(-MAX_RUNS * 3)) { try { this.remember(JSON.parse(line) as RunRow) } catch { /* torn line */ } }
    } catch { /* none yet */ }
    this.loaded = true
  }

  save(): Promise<void> { return this.files.data.write(this.data) }
  saveSecrets(): Promise<void> { return this.files.secrets.write(this.secrets) }
  saveQueue(): Promise<void> { return this.files.queue.write(this.queue) }
  async flushed(): Promise<void> {
    if (this.seenTimer !== undefined) { clearTimeout(this.seenTimer); this.seenTimer = undefined; void this.writeSeen() }
    await Promise.all([this.files.data.flushed(), this.files.secrets.flushed(), this.files.seen.flushed(), this.files.queue.flushed()])
  }

  get(id: string): Automation | undefined { return this.data.automations.find((a) => a.id === id) }

  // ---------- runs ----------
  private remember(row: RunRow): void {
    if (typeof row?.runId !== 'string') return
    this.runs.set(row.runId, row)
    if (this.runs.size > MAX_RUNS) { const first = this.runs.keys().next().value; if (first !== undefined) this.runs.delete(first) }
  }
  async log(row: RunRow): Promise<void> {
    this.remember(row)
    await appendFile(this.runsPath, `${JSON.stringify(row)}\n`, { mode: 0o600 }).catch(() => {})
  }
  run(runId: string): RunRow | undefined { return this.runs.get(runId) }
  /** Rows whose latest status is `pending` (delivery interrupted by a restart). */
  pendingRuns(): RunRow[] { return [...this.runs.values()].filter((r) => r.status === 'pending') }
  /** Latest row per runId, newest first. */
  recentRuns(limit = 100, automationId?: string): RunRow[] {
    const all = [...this.runs.values()].filter((r) => automationId === undefined || r.automationId === automationId)
    all.sort((a, b) => b.at - a.at)
    return all.slice(0, limit)
  }
  lastRun(automationId: string): RunRow | null {
    let best: RunRow | null = null
    for (const r of this.runs.values()) if (r.automationId === automationId && (best === null || r.at >= best.at)) best = r
    return best
  }
  /** Non-test runs that consumed rate budget (pending/queued/delivered) since `sinceMs`. */
  countedSince(sinceMs: number, automationId?: string): number {
    let n = 0
    for (const r of this.runs.values()) if (r.at >= sinceMs && r.test !== true && COUNTED.has(r.status) && (automationId === undefined || r.automationId === automationId)) n++
    return n
  }
  lastCountedAt(automationId: string): number {
    let at = 0
    for (const r of this.runs.values()) if (r.automationId === automationId && r.test !== true && COUNTED.has(r.status) && r.at > at) at = r.at
    return at
  }

  // ---------- dedupe + file baselines ----------
  hasSeen(automationId: string, eventId: string): boolean { return this.seenIds.has(`${automationId}\n${eventId}`) }
  markSeen(automationId: string, eventId: string): void {
    const key = `${automationId}\n${eventId}`
    this.seenIds.delete(key); this.seenIds.add(key)
    while (this.seenIds.size > MAX_SEEN_IDS) { const first = this.seenIds.values().next().value; if (first === undefined) break; this.seenIds.delete(first) }
    this.scheduleSeen()
  }
  isKnownFile(automationId: string, real: string): boolean { return this.known.get(automationId)?.has(real) === true }
  markKnownFiles(automationId: string, reals: Iterable<string>): void {
    const set = this.known.get(automationId) ?? new Set<string>()
    for (const r of reals) { set.delete(r); set.add(r) }
    while (set.size > MAX_KNOWN_FILES) { const first = set.values().next().value; if (first === undefined) break; set.delete(first) }
    this.known.set(automationId, set)
    this.scheduleSeen()
  }
  hasBaseline(automationId: string, key: string): boolean { return this.baselines[automationId] === key }
  setBaseline(automationId: string, key: string): void { this.baselines[automationId] = key; this.scheduleSeen() }
  forget(automationId: string): void {
    this.known.delete(automationId)
    delete this.baselines[automationId]
    for (const k of this.seenIds) if (k.startsWith(`${automationId}\n`)) this.seenIds.delete(k)
    delete this.queue[automationId]; void this.saveQueue().catch(() => {})
    delete this.secrets[automationId]; void this.saveSecrets().catch(() => {})
    this.scheduleSeen()
  }
  private scheduleSeen(): void {
    if (this.seenTimer !== undefined) return
    this.seenTimer = setTimeout(() => { this.seenTimer = undefined; void this.writeSeen() }, 250)
    this.seenTimer.unref?.()
  }
  private writeSeen(): Promise<void> {
    return this.files.seen.write({ ids: [...this.seenIds], files: Object.fromEntries([...this.known].map(([k, v]) => [k, [...v]])), baselines: this.baselines }).catch(() => {})
  }
}

/** Rate decision for one non-test event (undefined = allowed). */
export function rateDecision(store: Pick<TriggersStore, 'countedSince' | 'lastCountedAt'>, automation: Pick<Automation, 'id' | 'limits'>, now: number, globalPerHour = GLOBAL_MAX_PER_HOUR): string | undefined {
  if (now - store.lastCountedAt(automation.id) < automation.limits.minIntervalSec * 1000) return 'min-interval'
  if (store.countedSince(now - 3_600_000, automation.id) >= automation.limits.maxPerHour) return 'rate-limited'
  if (store.countedSince(now - 3_600_000) >= globalPerHour) return 'global-rate-limited'
  return undefined
}

/** Token bucket for `rejected` rows: at most `perMinute` rows per rolling minute. */
export class RejectLimiter {
  private stamps: number[] = []
  constructor(private readonly perMinute = 10) {}
  allow(now: number): boolean {
    this.stamps = this.stamps.filter((t) => now - t < 60_000)
    if (this.stamps.length >= this.perMinute) return false
    this.stamps.push(now)
    return true
  }
}
