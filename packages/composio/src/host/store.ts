/** Recipes + routes (`recipes.json`, atomic write) and the append-only run log (`runs.jsonl`) under `$DSH_HOME/composio/`. No secrets here. */
import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export interface ModelRoute { provider: string; model: string; reasoningEffort?: string }
export interface Recipe {
  id: string; name: string; promptTemplate: string
  cwd?: string | undefined
  agentPreset?: string | undefined
  model: ModelRoute | null
  /** Trigger runs in a new session: tools outside this allowlist pause for approval. */
  allowToolkits: string[]; allowTools: string[]
  sandbox: 'read-only' | 'workspace-write'
  payload: { maxChars?: number; include?: string[] }
  sessionTitle?: string | undefined
  createdAt: number; updatedAt: number
}
export interface Limits { maxRunsPerHour: number; minIntervalSec: number }
export interface Route {
  id: string; name: string; enabled: boolean
  triggerSlug: string; toolkit: string; connectedAccountId: string; triggerConfig: Record<string, unknown>; triggerInstanceId: string
  recipeId: string
  target: { mode: 'new-session' } | { mode: 'existing-session'; sessionId: string; /** The user accepted that untrusted trigger text enters this live session (CO-1). */ acknowledged?: boolean }
  limits: Limits
  consecutiveFailures: number
  createdAt: number
}
export interface Data { version: 1; paused: boolean; recipes: Recipe[]; routes: Route[] }

export type RunStatus = 'received' | 'skipped' | 'delivered' | 'failed' | 'queued'
export interface RunRow {
  runId: string; at: number; routeId: string; routeName: string; recipeId: string; mode: string
  event: { id: string; slug: string; toolkit: string; bytes: number }
  status: RunStatus; reason?: string; sessionId?: string; model?: string; error?: string
}

export const DEFAULT_LIMITS: Limits = { maxRunsPerHour: 6, minIntervalSec: 30 }
export const emptyData = (): Data => ({ version: 1, paused: false, recipes: [], routes: [] })

export class ComposioStore {
  data: Data = emptyData()
  private runs: RunRow[] = []
  private writing: Promise<void> = Promise.resolve()
  constructor(readonly dir: string) {}

  get dataPath(): string { return join(this.dir, 'recipes.json') }
  get runsPath(): string { return join(this.dir, 'runs.jsonl') }

  async load(): Promise<void> {
    await mkdir(this.dir, { recursive: true })
    try {
      const parsed = JSON.parse(await readFile(this.dataPath, 'utf8')) as Partial<Data>
      if (parsed.version === 1) this.data = { version: 1, paused: parsed.paused === true, recipes: parsed.recipes ?? [], routes: parsed.routes ?? [] }
    } catch { /* first run */ }
    try {
      const text = await readFile(this.runsPath, 'utf8')
      const rows = text.split('\n').filter((l) => l !== '').slice(-2000)
      for (const line of rows) { try { this.runs.push(JSON.parse(line) as RunRow) } catch { /* skip torn line */ } }
    } catch { /* none yet */ }
  }

  /** Serialised atomic save. */
  save(): Promise<void> {
    const snapshot = JSON.stringify(this.data, null, 2)
    this.writing = this.writing.then(async () => {
      const tmp = `${this.dataPath}.tmp`
      await mkdir(dirname(this.dataPath), { recursive: true })
      await writeFile(tmp, snapshot, { mode: 0o600 })
      await rename(tmp, this.dataPath)
    })
    return this.writing
  }

  async log(row: RunRow): Promise<void> {
    this.runs.push(row)
    if (this.runs.length > 2000) this.runs.splice(0, this.runs.length - 2000)
    await appendFile(this.runsPath, `${JSON.stringify(row)}\n`, { mode: 0o600 }).catch(() => {})
  }
  recentRuns(n = 100): RunRow[] { return this.runs.slice(-n).reverse() }
  seenEventIds(): string[] { return this.runs.map((r) => r.event.id) }
  /** Count of delivered runs of `routeId` since `sinceMs`. */
  deliveredSince(routeId: string, sinceMs: number): number { return this.runs.filter((r) => r.routeId === routeId && r.status === 'delivered' && r.at >= sinceMs).length }
  lastDeliveredAt(routeId: string): number { for (let i = this.runs.length - 1; i >= 0; i--) { const r = this.runs[i]; if (r !== undefined && r.routeId === routeId && r.status === 'delivered') return r.at } return 0 }
  globalDeliveredSince(sinceMs: number): number { return this.runs.filter((r) => r.status === 'delivered' && r.at >= sinceMs).length }
}

export const newId = (prefix: string): string => `${prefix}_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36).slice(-4)}`

/** Rate limit decision for one event. */
export function rateDecision(store: Pick<ComposioStore, 'deliveredSince' | 'lastDeliveredAt' | 'globalDeliveredSince'>, route: Route, now: number, globalPerHour = 30): string | undefined {
  if (now - store.lastDeliveredAt(route.id) < route.limits.minIntervalSec * 1000) return 'min-interval'
  if (store.deliveredSince(route.id, now - 3_600_000) >= route.limits.maxRunsPerHour) return 'rate-limited'
  if (store.globalDeliveredSince(now - 3_600_000) >= globalPerHour) return 'global-rate-limited'
  return undefined
}

/** True when any remaining route still points at this Composio trigger instance. */
export const instanceStillUsed = (routes: readonly Pick<Route, 'triggerInstanceId'>[], instanceId: string): boolean => routes.some((r) => r.triggerInstanceId === instanceId)
