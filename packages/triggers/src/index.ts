/**
 * Host half of Triggers: event → chat automations.
 *  - sources: webhook (`POST /hooks/<id>` on the DSH web server), file (recursive watch + catch-up scan), composio
 *    (`ctx.triggers.ingest`, called by dsh-composio);
 *  - launcher: new chat per event or one reused chat (queued while busy), tighten-only sandbox, read-only tool guard
 *    lifted on the next human message, model through dsh-automation-models when present;
 *  - routes POST /api/triggers/* for the page (fail closed, same-origin), agent tools triggers_list/save/test.
 * Never calls sessionController.selectModel (it rewrites the global default model).
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage, type ContextFormed } from '@deepseek-ai/dsh-llm'
import { API_BASE, HOOK_BASE, type ModelRoute } from './shared/types.ts'
import { METHODS, routeHandler, serveRoute, type ConnectionLike } from './host/routes.ts'
import type { ComposioServiceLike } from './host/composio.ts'
import { TriggersEngine } from './host/engine.ts'
import { createHookHandler } from './host/hooks.ts'
import { RunLauncher, type AgentLike, type SessionControllerLike } from './host/launcher.ts'
import { PinStore, TurnPins, type PinnableAgent } from './host/pin.ts'
import { TriggersStore } from './host/store.ts'
import { triggerTools } from './host/tools.ts'
import { dshHome, errorText } from './host/util.ts'

export const name = '@t3labs/ohmydsh-triggers'
export const inject = ['agents', 'tools', 'sessions']

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** A message started by a Triggers automation. `automationId` keys per-automation model overrides; `pinned` = the automation chose the model. */
    trigger: { kind: 'trigger'; automationId?: string; pinned?: boolean } & ContextFormed
  }
}

/** Composio (or any plugin) event ingress. */
export interface ComposioIngestEvent { source: 'composio'; triggerSlug: string; triggerInstanceId?: string; eventId: string; data: Record<string, unknown> }
export class TriggersService {
  constructor(private readonly engine: TriggersEngine) {}
  /** Route one Composio trigger event to every matching enabled automation. `matched` = deliveries accepted. */
  ingest(event: ComposioIngestEvent): Promise<{ matched: number }> { return this.engine.ingest(event) }
}

declare module '@deepseek-ai/cordis' {
  interface Context { triggers: TriggersService }
}

export { METHODS, sameOrigin } from './host/routes.ts'

interface Services {
  agents: { get(id: string): AgentLike | undefined; withoutInitiator<T>(op: () => T): T }
  sessions: { flush(session: unknown): Promise<boolean> }
}
interface WorkspaceLike { path: string; title: string; attachSession(id: string): Promise<void> }
interface RegistryLike { list(): WorkspaceLike[]; resolveByPath(p: string): Promise<WorkspaceLike | undefined>; archivedSessionIds: readonly string[] }
interface AutomationModelsLike { applyTo(agent: unknown, route: ModelRoute, o?: { restore?: 'idle' | 'never' }): boolean; registerSource(kind: string, spec: unknown): () => void }


export function apply(ctx: Context): void {
  const log = { info: (m: string) => { ctx.logger.info(m) }, warn: (m: string) => { ctx.logger.warn(m) } }
  const dir = join(dshHome(), 'triggers')
  const store = new TriggersStore(dir)
  const svc = ctx as unknown as Services
  const get = <T>(key: string): T | undefined => (ctx as unknown as { get(k: string): T | undefined }).get(key)
  const events = ctx as unknown as { on(name: string, listener: (...args: never[]) => unknown): () => void }
  const registry = (): RegistryLike | undefined => get<RegistryLike>('workspaceRegistry')
  const automationModels = (): AutomationModelsLike | undefined => get<AutomationModelsLike>('automationModels')
  const currentMode = (agent: PinnableAgent): string | undefined => {
    try { return get<{ resolve(r: { session: unknown }): { mode?: string } }>('sandboxPolicy')?.resolve({ session: (agent as unknown as AgentLike).session }).mode } catch { return undefined }
  }

  // ---------- pins (tool guard + tighten-only sandbox, lifted on a human turn) ----------
  const pins = new TurnPins({ currentMode, log, persist: new PinStore(join(dir, 'pins.json')) })
  ctx.effect(() => events.on('agent/inbox/claimed', ((p: { agent: PinnableAgent; message: { source?: { kind?: string } } }) => { pins.onClaimed(p.agent, p.message) }) as never), 'triggers: lift pin on human turn')
  ctx.effect(() => events.on('agent/created', ((p: { agent: PinnableAgent }) => { pins.onCreated(p.agent, p.agent.id) }) as never), 'triggers: restore stale pin')
  void pins.load()

  // ---------- launcher ----------
  let engine: TriggersEngine | undefined
  const launcher = new RunLauncher({
    controller: () => get<SessionControllerLike>('sessionController'),
    liveAgent: (id) => svc.agents.get(id),
    archived: (id) => (registry()?.archivedSessionIds ?? []).includes(id),
    makeMessage: (text, automationId, pinned) => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'trigger', automationId, ...(pinned ? { pinned: true } : {}) } }),
    flush: (agent) => svc.sessions.flush(agent.session),
    rename: (agent, title) => { get<{ rename(s: unknown, t: string): unknown }>('sessionTitle')?.rename(agent.session, title) },
    attachWorkspace: async (sessionId, cwd) => {
      const reg = registry()
      if (reg === undefined) return
      try { await (await reg.resolveByPath(cwd))?.attachSession(sessionId) } catch (error) { log.warn(`triggers: workspace attach failed: ${errorText(error)}`) }
    },
    applyModel: (agent, route, restore) => {
      const am = automationModels()
      if (am !== undefined) return am.applyTo(agent, route, { restore })
      if (restore === 'never') { agent.model.select(route); return true } // new chat: nothing to restore
      return false // an existing chat without dsh-automation-models: never leave its model changed
    },
    currentMode,
    pinTurn: (agent, policy) => { pins.apply(agent, agent.id, policy) },
    queue: { get items() { return store.queue }, save: () => store.saveQueue() },
    automation: (id) => store.get(id),
    setReuseSession: async (automationId, sessionId) => {
      const a = store.get(automationId)
      if (a === undefined) return
      a.target.sessionId = sessionId
      await store.save()
    },
    onQueueResult: (runIds, result) => { void engine?.queueResult(runIds, result).catch(() => {}) },
    log,
  })

  // ---------- engine ----------
  let web: { register(r: unknown): () => void; getOrigin(): string } | undefined
  const origin = (): string => { try { return web?.getOrigin() ?? 'http://127.0.0.1:3080' } catch { return 'http://127.0.0.1:3080' } }
  engine = new TriggersEngine({
    store,
    deliver: (automation, delivery) => svc.agents.withoutInitiator(() => launcher.deliver(automation, delivery)),
    origin,
    hasAutomationModels: () => automationModels() !== undefined,
    hasComposio: () => get('composio') !== undefined,
    composio: () => get<ComposioServiceLike>('composio'),
    workspaces: () => (registry()?.list() ?? []).map((w) => ({ path: w.path, title: w.title })),
    defaultCwd: () => registry()?.list()[0]?.path ?? homedir(),
    queuedFor: (id) => launcher.queuedFor(id),
    log,
  })
  const eng = engine
  ctx.provide('triggers', new TriggersService(eng))

  // ---------- agents: tools + queue flush on idle ----------
  const attached = new WeakSet<object>()
  ctx.effect(() => events.on('agent/created', ((p: { agent: AgentLike & { ctx: { tools: { register(d: unknown): () => void }; on(n: string, l: (...a: never[]) => void): () => void } } }) => {
    try {
      const agent = p.agent
      if (attached.has(agent) || agent.session.header?.origin === 'subagent') return
      attached.add(agent)
      agent.ctx.effect(() => {
        const disposers = triggerTools(eng).map((tool) => agent.ctx.tools.register(tool))
        const stop = agent.ctx.on('agent/status', ((s: { status: string }) => {
          if (s.status === 'idle') void launcher.flushQueue(agent).catch((error: unknown) => { log.warn(`triggers: queue flush failed: ${errorText(error)}`) })
        }) as never)
        return () => { stop(); for (const d of disposers) d() }
      }, 'triggers: tools')
    } catch (error) { log.warn(`triggers: could not attach tools: ${errorText(error)}`) }
  }) as never), 'triggers: agent hook')

  // ---------- automation-models source ----------
  ctx.inject(['automationModels'], (c: Context) => {
    const am = (c as unknown as { automationModels: AutomationModelsLike }).automationModels
    c.effect(() => am.registerSource('trigger', {
      label: 'Triggers',
      keyOf: (m: { source: { automationId?: string } }) => m.source.automationId,
      isRun: (m: { source: { pinned?: boolean } }) => m.source.pinned !== true, // an automation that pins its model is not overridden
    }), 'triggers: automation-models source')
  })

  // ---------- webhook ingress ----------
  const hook = createHookHandler({ engine: eng, store, log })
  ctx.inject(['webServer'], (c: Context) => {
    c.effect(() => {
      const server = (c as unknown as { webServer?: NonNullable<typeof web> }).webServer
      if (server === undefined) return () => {}
      web = server
      const stop = server.register({ kind: 'prefix', path: HOOK_BASE, handler: hook })
      return () => { stop(); if (web === server) web = undefined }
    }, 'triggers: webhook ingress')
  })

  // ---------- lifecycle ----------
  let stopped = false
  void store.load().then(async () => {
    if (stopped) return
    // A delivery in flight when the previous process stopped never finished.
    for (const row of store.pendingRuns()) await store.log({ ...row, status: 'failed', error: 'Interrupted by a restart before the chat was started.' })
    eng.syncWatchers()
    log.info(`triggers: ready (${String(store.data.automations.length)} automations)`)
    // Deliveries queued before a restart: flush chats that are idle now.
    const controller = get<SessionControllerLike>('sessionController')
    for (const sessionId of launcher.queuedSessions()) {
      try {
        const live = svc.agents.get(sessionId)
        const agent = live ?? (controller === undefined ? undefined : await controller.resolveAgent(sessionId).then((r) => ('agent' in r ? r.agent : undefined)))
        if (agent !== undefined) await launcher.flushQueue(agent)
      } catch (error) { log.warn(`triggers: could not drain the queue of ${sessionId}: ${errorText(error)}`) }
    }
  }).catch((error: unknown) => { log.warn(`triggers: storage failed to load: ${errorText(error)}`) })
  ctx.effect(() => () => { stopped = true; eng.stop(); void store.flushed() }, 'triggers: watchers')

  // ---------- page routes ----------
  const handle = routeHandler({ engine: eng, store, modelCatalog: async () => { const c = get<{ modelCatalog(): Promise<unknown> }>('sessionController'); return c === undefined ? null : c.modelCatalog() } })

  ctx.inject(['connection'], (c: Context) => {
    const connection = (c as unknown as { connection: ConnectionLike & { fetch: { register(r: unknown): () => Promise<void> } } }).connection
    for (const method of METHODS) {
      c.effect(() => connection.fetch.register({
        path: `${API_BASE}/${method}`, methods: ['POST'], requestBody: 'buffered',
        fetch: (request: Request) => serveRoute(method, request, { connection, handle, log }),
      }), `triggers: ${method} route`)
    }
  })
}
