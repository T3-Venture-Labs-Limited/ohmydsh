/**
 * Pure core of dsh-automation-models: source registry, route resolution and the temporary model switch.
 * No Cordis imports here, so every rule is unit-testable. The plugin entry (../index.ts) wires it to the host:
 * `agent/inbox/claimed` -> onClaimed, `agent/status` -> onStatus, `agent/created` -> onCreated.
 *
 * Mechanism: the agent loop reads `agent.model.current()` synchronously right
 * after `inbox.claim()` emits `agent/inbox/claimed`, so a synchronous `agent.model.select()` in the listener always
 * applies to exactly the first step of the automation turn. We never call sessionController.selectModel, because that
 * also rewrites the profile's global default model.
 */

export interface Route { provider: string; model: string; reasoningEffort?: string }

/** The built-in default for every automation source: design decision (2026-11-13). */
export const BUILTIN_DEFAULT: Readonly<Route> = Object.freeze({ provider: 'claude', model: 'claude-sonnet-5-5', reasoningEffort: 'low' })

export interface MessageLike { readonly source: { readonly kind: string }; readonly content: readonly unknown[] }

export interface SourceSpec {
  /** Name shown on the Automation models page. */
  label: string
  /** Default route for this source when the user has not stored one. Falls back to BUILTIN_DEFAULT. */
  defaultRoute?: Route | undefined
  /** Stable key for per-item overrides (e.g. a schedule task id); an array lets a batched message carry several (first wins). */
  keyOf?: ((message: MessageLike) => string | readonly string[] | undefined) | undefined
  /** Return false for housekeeping messages that merely share the source kind (e.g. [SCHEDULE CHANGE] notices). */
  isRun?: ((message: MessageLike) => boolean) | undefined
}

export interface RegisteredSource extends SourceSpec { kind: string; builtin: boolean }

export type Via = 'override' | 'default' | 'source-default' | 'builtin'

export interface Resolution {
  kind: string
  key?: string
  route: Route
  via: Via
  /** 'idle' (temporary: restore the session's model when the turn ends) or 'never' (per-item "keep model after run"). */
  restore: 'idle' | 'never'
  /** Candidates skipped because the model is known to be unavailable. */
  skipped: string[]
}

export interface OverrideRecord { route: Route | null; keep?: boolean }
export interface DefaultRecord { route: Route | null }
export interface MarkerRecord { previous: Route; applied: Route; at: number }

export interface StoreFace {
  enabled(): boolean
  getDefault(kind: string): DefaultRecord | undefined
  getOverride(kind: string, key: string): OverrideRecord | undefined
  getMarker(agentId: string): MarkerRecord | undefined
  putMarker(agentId: string, marker: MarkerRecord): void
  deleteMarker(agentId: string): void
}

export interface AgentLike {
  readonly id: string
  readonly model: { current(): Readonly<Route> | undefined; select(route: Readonly<Route>): void }
  readonly session?: { readonly header?: { readonly origin?: string } }
}

export interface Notice { at: number; level: 'info' | 'warn'; text: string }

export interface CoreDeps {
  store: StoreFace
  /** true/false when the model catalog knows the answer, undefined while it is still loading. */
  available: (route: Route) => boolean | undefined
  log: { info(message: string): void; warn(message: string): void }
  now?: () => number
}

const same = (a: Readonly<Route> | undefined, b: Readonly<Route> | undefined): boolean =>
  a === b || (a !== undefined && b !== undefined && a.provider === b.provider && a.model === b.model && a.reasoningEffort === b.reasoningEffort)

export const routeLabel = (route: Readonly<Route>): string =>
  `${route.provider}/${route.model}${route.reasoningEffort === undefined ? '' : ` (${route.reasoningEffort})`}`

const detach = (route: Readonly<Route>): Route => ({ provider: route.provider, model: route.model, ...(route.reasoningEffort === undefined ? {} : { reasoningEffort: route.reasoningEffort }) })

interface Active { previous: Route; applied: Route; restore: 'idle' | 'never'; turn: number }

export function textOf(message: MessageLike): string {
  for (const block of message.content) {
    const b = block as { type?: string; text?: unknown }
    if (b.type === 'text' && typeof b.text === 'string') return b.text
  }
  return ''
}

/** Schedule reminders: `schedule_id_json: "<id>"` (single) or `reminders_json: [{schedule_id,...}]` (batch). Stopgap until upstream adds a structured id. */
export function scheduleKeys(message: MessageLike): string[] | undefined {
  const text = textOf(message)
  const batch = /^reminders_json: (.+)$/m.exec(text)
  if (text.startsWith('[SCHEDULE REMINDER BATCH]') && batch?.[1] !== undefined) {
    try {
      const parsed = JSON.parse(batch[1]) as unknown
      if (!Array.isArray(parsed)) return undefined
      const ids = parsed.flatMap((entry) => (typeof (entry as { schedule_id?: unknown })?.schedule_id === 'string' ? [(entry as { schedule_id: string }).schedule_id] : []))
      return ids.length > 0 ? ids : undefined
    } catch { return undefined }
  }
  const single = /^schedule_id_json: (.+)$/m.exec(text)
  if (text.startsWith('[SCHEDULE REMINDER]') && single?.[1] !== undefined) {
    try { const id = JSON.parse(single[1]) as unknown; return typeof id === 'string' ? [id] : undefined } catch { return undefined }
  }
  return undefined
}

export const isScheduleRun = (message: MessageLike): boolean => textOf(message).startsWith('[SCHEDULE REMINDER')

export class AutomationModelsCore {
  private readonly sources = new Map<string, RegisteredSource>()
  private readonly active = new WeakMap<object, Active>()
  private readonly activeById = new Map<string, Active>()
  private readonly notices: Notice[] = []
  private readonly now: () => number

  constructor(private readonly deps: CoreDeps) {
    this.now = deps.now ?? Date.now
    this.sources.set('schedule', { kind: 'schedule', label: 'Scheduled tasks', builtin: true, keyOf: scheduleKeys, isRun: isScheduleRun })
    this.sources.set('sentinel', { kind: 'sentinel', label: 'Sentinel wake-ups', builtin: true })
  }

  /** Register (or replace) an automation source. Returns a disposer that only removes this exact registration. */
  registerSource(kind: string, spec: SourceSpec): () => void {
    if (kind.length === 0 || kind === 'user' || kind === 'model' || kind === 'tool' || kind === 'system-prompt') throw new Error(`automation-models: "${kind}" cannot be an automation source`)
    const prior = this.sources.get(kind)
    const entry: RegisteredSource = {
      // A builtin keeps its key/isRun parsers unless the registrant supplies its own.
      kind, builtin: prior?.builtin ?? false, label: spec.label,
      defaultRoute: spec.defaultRoute,
      keyOf: spec.keyOf ?? prior?.keyOf,
      isRun: spec.isRun ?? prior?.isRun,
    }
    this.sources.set(kind, entry)
    return () => { if (this.sources.get(kind) === entry) { if (prior !== undefined && prior.builtin) this.sources.set(kind, prior); else this.sources.delete(kind) } }
  }

  listSources(): RegisteredSource[] { return [...this.sources.values()] }
  getSource(kind: string): RegisteredSource | undefined { return this.sources.get(kind) }
  recentNotices(): Notice[] { return [...this.notices] }

  private note(level: Notice['level'], text: string): void {
    this.notices.push({ at: this.now(), level, text })
    if (this.notices.length > 30) this.notices.shift()
    this.deps.log[level](`automation-models: ${text}`)
  }

  /** The route an automation message would run on, or undefined when it should stay on the session's own model. */
  resolveFor(message: MessageLike): Resolution | undefined {
    const source = this.sources.get(message.source.kind)
    if (source === undefined) return undefined
    if (source.isRun !== undefined && !source.isRun(message)) return undefined
    const keys = source.keyOf?.(message)
    const key = typeof keys === 'string' ? keys : keys?.[0] // batch: first task wins
    return this.resolveKind(source, key)
  }

  resolveKind(source: RegisteredSource, key: string | undefined): Resolution | undefined {
    const { store } = this.deps
    const candidates: { route: Route; via: Via }[] = []
    let keep = false
    if (key !== undefined) {
      const override = store.getOverride(source.kind, key)
      if (override !== undefined) {
        if (override.route === null) return undefined // explicit "use the session's model" for this item
        candidates.push({ route: override.route, via: 'override' })
        keep = override.keep === true
      }
    }
    const stored = store.getDefault(source.kind)
    if (stored !== undefined) {
      if (stored.route === null && candidates.length === 0) return undefined
      if (stored.route !== null) candidates.push({ route: stored.route, via: 'default' })
    } else if (source.defaultRoute !== undefined) candidates.push({ route: source.defaultRoute, via: 'source-default' })
    candidates.push({ route: BUILTIN_DEFAULT, via: 'builtin' })

    const skipped: string[] = []
    for (const candidate of candidates) {
      if (this.deps.available(candidate.route) === false) { skipped.push(routeLabel(candidate.route)); continue }
      return { kind: source.kind, ...(key === undefined ? {} : { key }), route: detach(candidate.route), via: candidate.via, restore: keep && candidate.via === 'override' ? 'never' : 'idle', skipped }
    }
    return undefined
  }

  /** `agent/inbox/claimed` listener body. MUST stay synchronous. */
  onClaimed(agent: AgentLike, message: MessageLike, turn = 0): void {
    try {
      if (!this.deps.store.enabled()) return
      if (agent.session?.header?.origin === 'subagent') return
      if (this.active.has(agent)) return // one switch per automation turn
      const resolution = this.resolveFor(message)
      if (resolution === undefined) return
      if (resolution.skipped.length > 0) this.note('warn', `${resolution.kind}: ${resolution.skipped.join(', ')} unavailable; using ${routeLabel(resolution.route)}`)
      this.applyResolved(agent, resolution.route, resolution.restore, turn)
    } catch (error) {
      // A failing listener must never break the turn: fail open, stay on the session's model.
      this.note('warn', `could not switch model: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** Reusable primitive for other plugins: switch `agent` to `route` for the current turn and restore afterwards. */
  applyTo(agent: AgentLike, route: Route, options: { restore?: 'idle' | 'never' } = {}): boolean {
    if (this.active.has(agent)) return false
    return this.applyResolved(agent, detach(route), options.restore ?? 'idle', 0)
  }

  private applyResolved(agent: AgentLike, route: Route, restore: 'idle' | 'never', turn: number): boolean {
    const previous = agent.model.current()
    if (previous === undefined) return false // no route to come back to; leave the session alone
    if (same(previous, route)) return false
    agent.model.select(route)
    const entry: Active = { previous: detach(previous), applied: route, restore, turn }
    this.active.set(agent, entry)
    if (restore === 'idle') {
      this.activeById.set(agent.id, entry)
      this.deps.store.putMarker(agent.id, { previous: entry.previous, applied: route, at: this.now() })
    }
    this.deps.log.info(`automation-models: ${agent.id} ${routeLabel(entry.previous)} -> ${routeLabel(route)}${restore === 'idle' ? ' (temporary)' : ''}`)
    return true
  }

  /** `agent/status` listener: restore on idle when the selection is still the one we set. */
  onStatus(agent: AgentLike, status: string): void {
    if (status !== 'idle') return
    const entry = this.active.get(agent)
    if (entry === undefined) return
    this.active.delete(agent)
    this.activeById.delete(agent.id)
    if (entry.restore === 'idle') {
      this.deps.store.deleteMarker(agent.id)
      try {
        if (same(agent.model.current(), entry.applied)) {
          agent.model.select(entry.previous)
          this.deps.log.info(`automation-models: ${agent.id} restored ${routeLabel(entry.previous)}`)
        } // else the user (or something else) changed the model meanwhile: leave it.
      } catch (error) {
        this.note('warn', `could not restore model: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }

  /** `agent/created` (source === 'resume'): a crash mid-turn left the cheap model on a session; undo it. */
  onCreated(agent: AgentLike, source: string): void {
    const marker = this.deps.store.getMarker(agent.id)
    if (marker === undefined || this.active.has(agent)) return
    this.deps.store.deleteMarker(agent.id)
    if (source !== 'resume') return
    try {
      if (same(agent.model.current(), marker.applied)) {
        agent.model.select(marker.previous)
        this.note('info', `restored ${routeLabel(marker.previous)} on ${agent.id} after an interrupted automation turn`)
      }
    } catch (error) {
      this.note('warn', `could not restore interrupted session: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  onDisposed(agent: AgentLike): void {
    this.active.delete(agent)
    this.activeById.delete(agent.id)
  }
}
