/**
 * Delivers one rendered event to a chat (launch order ported from dsh-composio launcher.ts):
 *  - target.mode `new`: controller.create (reserved id) → resolveAgent → workspace attach → sandbox tightened
 *    (`sandbox/mode`, never looser than the session's own mode) → tool guard pin (tools: 'read') → model → title →
 *    followup → sessions.flush.
 *  - target.mode `reuse`: one chat per automation, created like `new` on the first event; later events wake it with a
 *    followup. The turn is pinned (tool guard + tighten-only sandbox, lifted on the next human message). While the chat
 *    is busy, deliveries wait in a bounded (8, drop-oldest) persisted queue and are batched with `---` on idle.
 * Never calls sessionController.selectModel (it rewrites the global default model).
 */
import { randomUUID } from 'node:crypto'
import type { Automation, ModelRoute } from '../shared/types.ts'
import { stricter, type PinPolicy, type PinnableAgent } from './pin.ts'
import type { QueuedDelivery } from './store.ts'

export const MAX_QUEUE = 8

export interface AgentLike extends PinnableAgent {
  readonly id: string
  readonly status: string
  readonly session: { header?: { origin?: string } | undefined; append(type: string, data: unknown): unknown }
  readonly model: { current(): Readonly<ModelRoute> | undefined; select(route: Readonly<ModelRoute>): void }
  followup(message: unknown): void
}
export interface SessionControllerLike {
  create(request: { sessionId: string; cwd?: string }): Promise<unknown>
  resolveAgent(sessionId: string): Promise<{ agent: AgentLike } | { error: unknown }>
}

export interface LauncherDeps {
  controller: () => SessionControllerLike | undefined
  liveAgent: (sessionId: string) => AgentLike | undefined
  archived: (sessionId: string) => boolean
  makeMessage: (text: string, automationId: string, pinned: boolean) => unknown
  flush: (agent: AgentLike) => Promise<boolean>
  rename: (agent: AgentLike, title: string) => void
  attachWorkspace: (sessionId: string, cwd: string) => Promise<void>
  /** true when the route was applied. `never` = new chat (nothing to restore); `idle` = restore after the turn. */
  applyModel: (agent: AgentLike, route: ModelRoute, restore: 'idle' | 'never') => boolean
  /** Effective sandbox mode of a session, undefined when unknown. */
  currentMode: (agent: AgentLike) => string | undefined
  /** Guard + tighten-only sandbox pin for the trigger turn; lifted on the next human message. Throws when unsafe. */
  pinTurn: (agent: AgentLike, policy: PinPolicy) => void
  /** Persisted per-automation queue. */
  queue: { items: Record<string, QueuedDelivery[]>; save(): Promise<void> }
  /** Lookup of the live automation (for flush time policy/model). */
  automation: (id: string) => Automation | undefined
  /** The reuse chat was (re)created. */
  setReuseSession: (automationId: string, sessionId: string) => Promise<void>
  /** Queued deliveries were sent (or dropped) — update their run rows. */
  onQueueResult: (runIds: readonly string[], result: { sessionId: string; model?: string } | { dropped: true; reason: string } | { error: string }) => void
  log: { info(m: string): void; warn(m: string): void }
}

export interface LaunchResult { sessionId: string; model?: string; queued?: boolean }
export interface Delivery { runId: string; text: string; title: string }

const describe = (error: unknown): string => String((error as { message?: string })?.message ?? error)
const modelLabel = (agent: AgentLike): string | undefined => { const c = agent.model.current(); return c === undefined ? undefined : `${c.provider}/${c.model}` }

export class RunLauncher {
  constructor(private readonly deps: LauncherDeps) {}

  get queued(): number { return Object.values(this.deps.queue.items).reduce((n, q) => n + q.length, 0) }
  queuedFor(automationId: string): number { return this.deps.queue.items[automationId]?.length ?? 0 }

  async deliver(automation: Automation, delivery: Delivery, newSessionId?: string): Promise<LaunchResult> {
    if (automation.target.mode === 'new') return this.launchNew(automation, delivery, newSessionId)
    return this.launchReuse(automation, delivery)
  }

  /** A fresh chat for this event. */
  async launchNew(automation: Automation, delivery: Delivery, sessionId: string = `session-${randomUUID()}`): Promise<LaunchResult> {
    const agent = await this.create(automation, sessionId, delivery.title)
    this.pinNew(agent, automation)
    const pinned = this.model(agent, automation, 'never')
    agent.followup(this.deps.makeMessage(delivery.text, automation.id, pinned))
    if (!(await this.deps.flush(agent))) throw new Error('Session persistence did not acknowledge the trigger message')
    const model = modelLabel(agent)
    return { sessionId, ...(model === undefined ? {} : { model }) }
  }

  /** One chat per automation: create on first use (or when the old one is gone), otherwise wake or queue. */
  async launchReuse(automation: Automation, delivery: Delivery): Promise<LaunchResult> {
    const existing = automation.target.sessionId
    const agent = existing === undefined ? undefined : await this.open(existing)
    if (agent === undefined) {
      const result = await this.launchNew(automation, delivery)
      await this.deps.setReuseSession(automation.id, result.sessionId)
      return result
    }
    const q = this.deps.queue.items[automation.id] ?? []
    if (agent.status !== 'idle') {
      q.push({ runId: delivery.runId, sessionId: agent.id, text: delivery.text, at: Date.now() })
      const dropped = q.length > MAX_QUEUE ? q.splice(0, q.length - MAX_QUEUE) : []
      this.deps.queue.items[automation.id] = q
      await this.deps.queue.save().catch(() => {})
      if (dropped.length > 0) this.deps.onQueueResult(dropped.map((d) => d.runId), { dropped: true, reason: 'queue-full' })
      return { sessionId: agent.id, queued: true }
    }
    // Idle: anything still queued goes out together with this event, in order.
    const batch = [...q, { runId: delivery.runId, sessionId: agent.id, text: delivery.text, at: Date.now() }]
    if (q.length > 0) { delete this.deps.queue.items[automation.id]; await this.deps.queue.save().catch(() => {}) }
    const result = await this.wake(agent, automation, batch.map((b) => b.text))
    const earlier = q.map((b) => b.runId)
    if (earlier.length > 0) this.deps.onQueueResult(earlier, result)
    return result
  }

  /** `agent/status` → idle: deliver everything queued for that chat as one followup. */
  async flushQueue(agent: AgentLike): Promise<boolean> {
    if (agent.status !== 'idle') return false
    let sent = false
    for (const [automationId, q] of Object.entries(this.deps.queue.items)) {
      const mine = q.filter((e) => e.sessionId === agent.id)
      if (mine.length === 0) continue
      const rest = q.filter((e) => e.sessionId !== agent.id)
      if (rest.length === 0) delete this.deps.queue.items[automationId]; else this.deps.queue.items[automationId] = rest
      await this.deps.queue.save().catch(() => {})
      const automation = this.deps.automation(automationId)
      const ids = mine.map((e) => e.runId)
      if (automation === undefined) { this.deps.onQueueResult(ids, { dropped: true, reason: 'automation-deleted' }); continue }
      try {
        this.deps.onQueueResult(ids, await this.wake(agent, automation, mine.map((e) => e.text)))
        sent = true
      } catch (error) {
        this.deps.log.warn(`triggers: queued delivery to ${agent.id} failed: ${describe(error)}`)
        this.deps.onQueueResult(ids, { error: describe(error).slice(0, 300) })
      }
      if (sent) break // the chat is busy again; the next idle flushes the rest
    }
    return sent
  }

  /** Session ids with queued deliveries (startup drain). */
  queuedSessions(): string[] { return [...new Set(Object.values(this.deps.queue.items).flatMap((q) => q.map((e) => e.sessionId)))] }

  // ---------- internals ----------
  private async create(automation: Automation, sessionId: string, title: string): Promise<AgentLike> {
    const controller = this.deps.controller()
    if (controller === undefined) throw new Error('No session creation provider is available')
    await controller.create({ sessionId, cwd: automation.target.cwd })
    const resolved = await controller.resolveAgent(sessionId)
    if ('error' in resolved) throw new Error(`Could not open the new chat: ${describe(resolved.error)}`)
    const { agent } = resolved
    await this.deps.attachWorkspace(sessionId, automation.target.cwd)
    // Tighten only: a new chat starts in the profile's default mode; the automation may only make it stricter.
    const now = this.deps.currentMode(agent)
    const mode = now === undefined ? 'read-only' : stricter(now, automation.target.sandbox)
    if (mode !== now) agent.session.append('sandbox/mode', { mode })
    try { this.deps.rename(agent, title) } catch (error) { this.deps.log.warn(`triggers: could not name chat: ${describe(error)}`) }
    return agent
  }

  private pinNew(agent: AgentLike, automation: Automation): void {
    if (automation.target.tools === 'read') this.deps.pinTurn(agent, { guard: true })
  }

  private model(agent: AgentLike, automation: Automation, restore: 'idle' | 'never'): boolean {
    const route = automation.target.model
    if (route === null) return false
    try { return this.deps.applyModel(agent, route, restore) } catch (error) { this.deps.log.warn(`triggers: model not applied: ${describe(error)}`); return false }
  }

  private async open(sessionId: string): Promise<AgentLike | undefined> {
    if (this.deps.archived(sessionId)) return undefined
    const live = this.deps.liveAgent(sessionId)
    if (live !== undefined) return this.usable(live)
    const controller = this.deps.controller()
    if (controller === undefined) throw new Error('No session provider is available to resume the chat')
    let resolved: { agent: AgentLike } | { error: unknown }
    try { resolved = await controller.resolveAgent(sessionId) } catch { return undefined }
    return 'error' in resolved ? undefined : this.usable(resolved.agent)
  }

  private usable(agent: AgentLike): AgentLike | undefined { return agent.session.header?.origin === 'subagent' ? undefined : agent }

  private async wake(agent: AgentLike, automation: Automation, texts: readonly string[]): Promise<{ sessionId: string; model?: string }> {
    // Pin before anything the payload can influence.
    this.deps.pinTurn(agent, { guard: automation.target.tools === 'read', sandbox: automation.target.sandbox })
    const pinned = this.model(agent, automation, 'idle')
    agent.followup(this.deps.makeMessage(texts.join('\n\n---\n\n'), automation.id, pinned))
    if (!(await this.deps.flush(agent))) throw new Error('Session persistence did not acknowledge the trigger message')
    const model = modelLabel(agent)
    return { sessionId: agent.id, ...(model === undefined ? {} : { model }) }
  }
}
