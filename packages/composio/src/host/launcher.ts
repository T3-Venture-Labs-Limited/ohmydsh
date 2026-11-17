/**
 * Delivers one trigger event to a session.
 *  - new-session: create a fresh session (id reserved in the run row first), pin sandbox, restrict tools, apply the
 *    recipe model, followup with the fenced prompt.
 *  - existing-session: needs the route's explicit risk acknowledgement; resolve (live or resume), pin the turn (tool guard +
 *    sandbox pin, lifted on the next human turn), followup when idle; when busy, queue (bounded) and flush on idle,
 *    pinning the batch the same way (CO-1).
 * Never calls sessionController.selectModel (it rewrites the global default model).
 */
import { randomUUID } from 'node:crypto'
import { renderPrompt } from './prompt.ts'
import type { NormalizedEvent } from './events.ts'
import { mergePolicies, type PinPolicy } from './pin.ts'
import type { ModelRoute, Recipe, Route } from './store.ts'

export const MAX_QUEUE = 8

export const policyOf = (recipe: Recipe): PinPolicy => ({ sandbox: recipe.sandbox, allowTools: recipe.allowTools, allowToolkits: recipe.allowToolkits })

export interface AgentLike {
  readonly id: string
  readonly status: string
  readonly ctx: { tools: { guard(g: (exec: { name: string }) => string | undefined): () => void }; effect(fn: () => () => void, label?: string): unknown }
  readonly session: { header?: { origin?: string }; append(type: string, data: unknown): unknown }
  readonly model: { current(): Readonly<ModelRoute> | undefined; select(route: Readonly<ModelRoute>): void }
  followup(message: unknown): void
}
export interface SessionControllerLike {
  create(request: { sessionId: string; cwd?: string; agentPreset?: string }): Promise<unknown>
  resolveAgent(sessionId: string): Promise<{ agent: AgentLike } | { error: unknown }>
}
export interface LauncherDeps {
  controller: () => SessionControllerLike | undefined
  liveAgent: (sessionId: string) => AgentLike | undefined
  archived: (sessionId: string) => boolean
  makeMessage: (text: string, pinned: boolean) => unknown
  flush: (agent: AgentLike) => Promise<boolean>
  rename: (agent: AgentLike, title: string) => void
  attachWorkspace: (sessionId: string, cwd: string | undefined) => Promise<void>
  applyModel: (agent: AgentLike, route: ModelRoute, restore: 'idle' | 'never') => boolean
  restrictRun: (agent: AgentLike, recipe: Recipe) => void
  /** Existing session: guard + sandbox pin + run policy for the composio-originated turn. Throws when it cannot be made safe. */
  pinTurn: (agent: AgentLike, policy: PinPolicy) => void
  log: { info(m: string): void; warn(m: string): void }
}

export interface LaunchResult { sessionId: string; model?: string }

/** Tools a trigger-run session keeps: composio_* plus plain reads. Everything else is denied by a guard. */
export const RUN_ALLOWED_TOOLS: readonly string[] = ['read', 'glob', 'grep', 'todo_write', 'skill', 'read_image']
export const runToolGuard = (exec: { name: string }): string | undefined =>
  (exec.name.startsWith('composio_') || RUN_ALLOWED_TOOLS.includes(exec.name) ? undefined : `${exec.name} is not available in a Composio trigger run (allowed: composio_* and read-only file tools).`)

export class RunLauncher {
  private readonly queues = new Map<string, { text: string; policy: PinPolicy }[]>()
  private queuedTotal = 0
  constructor(private readonly deps: LauncherDeps) {}

  get queued(): number { return this.queuedTotal }

  async launchNew(recipe: Recipe, route: Route, event: NormalizedEvent, sessionId: string = `session-${randomUUID()}`): Promise<LaunchResult> {
    const controller = this.deps.controller()
    if (controller === undefined) throw new Error('No session creation provider is available')
    await controller.create({ sessionId, ...(recipe.cwd === undefined ? {} : { cwd: recipe.cwd }), ...(recipe.agentPreset === undefined ? {} : { agentPreset: recipe.agentPreset }) })
    const resolved = await controller.resolveAgent(sessionId)
    if ('error' in resolved) throw new Error(`Could not open the new session: ${String((resolved.error as { message?: string })?.message ?? resolved.error)}`)
    const { agent } = resolved
    await this.deps.attachWorkspace(sessionId, recipe.cwd)
    agent.session.append('sandbox/mode', { mode: recipe.sandbox })
    this.deps.restrictRun(agent, recipe)
    if (recipe.model !== null) this.deps.applyModel(agent, recipe.model, 'never')
    const title = (recipe.sessionTitle ?? '{{recipe}} · {{route}}').replace(/\{\{recipe\}\}/g, recipe.name).replace(/\{\{route\}\}/g, route.name).replace(/\{\{trigger\.slug\}\}/g, event.triggerSlug)
    try { this.deps.rename(agent, title.slice(0, 120)) } catch (error) { this.deps.log.warn(`composio: could not name session: ${String(error)}`) }
    const text = renderPrompt(recipe.promptTemplate, { recipeName: recipe.name, routeName: route.name, event, payload: recipe.payload })
    agent.followup(this.deps.makeMessage(text, recipe.model !== null))
    if (!(await this.deps.flush(agent))) throw new Error('Session persistence did not acknowledge the trigger message')
    const current = agent.model.current()
    return { sessionId, ...(current === undefined ? {} : { model: `${current.provider}/${current.model}` }) }
  }

  async launchExisting(recipe: Recipe, route: Route & { target: { mode: 'existing-session'; sessionId: string } }, event: NormalizedEvent): Promise<LaunchResult & { queued?: boolean }> {
    const { sessionId } = route.target
    if ((route.target as { acknowledged?: boolean }).acknowledged !== true) throw new Error('This route wakes an existing session with untrusted trigger text and has not been acknowledged. Open Composio > Routes and acknowledge the risk to enable it.')
    if (this.deps.archived(sessionId)) throw new Error('The target session is archived')
    let agent = this.deps.liveAgent(sessionId)
    if (agent === undefined) {
      const controller = this.deps.controller()
      if (controller === undefined) throw new Error('No session provider is available to resume the target session')
      const resolved = await controller.resolveAgent(sessionId)
      if ('error' in resolved) throw new Error(`Target session cannot be opened: ${String((resolved.error as { message?: string })?.message ?? resolved.error)}`)
      agent = resolved.agent
    }
    if (agent.session.header?.origin === 'subagent') throw new Error('The target is a subagent session')
    const text = renderPrompt(recipe.promptTemplate, { recipeName: recipe.name, routeName: route.name, event, payload: recipe.payload })
    if (agent.status !== 'idle') {
      const q = this.queues.get(sessionId) ?? []
      if (q.length >= MAX_QUEUE) { q.shift(); this.queuedTotal-- }
      q.push({ text, policy: policyOf(recipe) }); this.queuedTotal++
      this.queues.set(sessionId, q)
      return { sessionId, queued: true }
    }
    this.deps.pinTurn(agent, policyOf(recipe)) // before anything the payload can influence
    if (recipe.model !== null) this.deps.applyModel(agent, recipe.model, 'idle')
    agent.followup(this.deps.makeMessage(text, recipe.model !== null))
    if (!(await this.deps.flush(agent))) throw new Error('Session persistence did not acknowledge the trigger message')
    return { sessionId }
  }

  /** `agent/status` -> idle: deliver everything queued for that session as one followup, batched with `---`. */
  flushQueue(sessionId: string, agent: AgentLike): boolean {
    const q = this.queues.get(sessionId)
    if (q === undefined || q.length === 0) return false
    this.queues.delete(sessionId); this.queuedTotal -= q.length
    this.deps.pinTurn(agent, mergePolicies(q.map((e) => e.policy)))
    agent.followup(this.deps.makeMessage(q.map((e) => e.text).join('\n\n---\n\n'), false))
    return true
  }
}
