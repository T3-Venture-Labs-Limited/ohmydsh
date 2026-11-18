/**
 * Host half of Composio.
 *  - agent tools composio_search / composio_execute / composio_link / composio_status (wrap the Composio CLI);
 *  - approval gate: read-only tools run, everything else asks; in a TRIGGER RUN anything outside the recipe's allowlist
 *    pauses for the user's approval (the standard approval flow; dsh-notify-me already notifies on `approval/asked`);
 *  - realtime trigger listener (outbound Pusher socket, lease per DSH_HOME) -> router -> recipes -> new session or wake
 *    of an existing session; run log; registers source 'composio' with dsh-automation-models when present;
 *  - routes /api/composio/* for the page (fail closed, same-origin for every call).
 * Never calls sessionController.selectModel (it rewrites the global default model).
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage, type ContextFormed } from '@deepseek-ai/dsh-llm'
import { ComposioApi, ApiError } from './host/api.ts'
import { ComposioCli } from './host/cli.ts'
import { ComposioService } from './host/service.ts'
import { ToolkitCatalog } from './host/catalog.ts'
import { composioTools } from './host/tools.ts'
import { gate, type RunPolicy } from './host/risk.ts'
import { PinStore, TurnPins, type PinnableAgent } from './host/pin.ts'
import { RunLauncher, runToolGuard, type AgentLike, type SessionControllerLike } from './host/launcher.ts'
import { TriggerListener } from './host/listener.ts'
import { ComposioStore, DEFAULT_LIMITS, instanceStillUsed, newId, rateDecision, type ModelRoute, type Recipe, type Route, type RunRow } from './host/store.ts'
import { CredsError, readCreds } from './host/creds.ts'
import type { NormalizedEvent } from './host/events.ts'

export const name = '@t3labs/ohmydsh-composio'
export const inject = ['agents', 'tools', 'sessions']
export const API = '/api/composio'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** A message started by a Composio trigger event. `routeId` keys per-route model overrides; `pinned` = the recipe chose the model. */
    composio: { kind: 'composio'; routeId?: string; pinned?: boolean } & ContextFormed
  }
}

type Json = Record<string, unknown>
interface Peerish { headers: Headers }
const ok = (value: unknown): Response => Response.json({ ok: true, value }, { headers: { 'cache-control': 'no-store' } })
const fail = (code: string, message: string, status = 200): Response => Response.json({ ok: false, error: { code, message } }, { status, headers: { 'cache-control': 'no-store' } })

export function sameOrigin(headers: Headers): boolean {
  const origin = headers.get('origin')
  if (origin === null) return true
  const host = headers.get('host')
  try { return host !== null && new URL(origin).host === host } catch { return false }
}

const str = (v: unknown, max = 4000): string | undefined => (typeof v === 'string' && v.length > 0 && v.length <= max ? v : undefined)
const strList = (v: unknown, max = 50): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.length > 0 && x.length < 200).slice(0, max) : [])
const route = (v: unknown): ModelRoute | null => {
  if (typeof v !== 'object' || v === null) return null
  const o = v as Json
  return typeof o['provider'] === 'string' && typeof o['model'] === 'string' ? { provider: o['provider'], model: o['model'], ...(typeof o['reasoningEffort'] === 'string' && o['reasoningEffort'] !== '' ? { reasoningEffort: o['reasoningEffort'] } : {}) } : null
}

interface Services {
  agents: { get(id: string): AgentLike | undefined }
  sessions: { flush(session: unknown): Promise<boolean> }
}

export function apply(ctx: Context): void {
  const log = { info: (m: string) => { ctx.logger.info(m) }, warn: (m: string) => { ctx.logger.warn(m) } }
  const dshHome = process.env['DSH_HOME'] ?? join(homedir(), '.dsh')
  const dir = join(dshHome, 'composio')
  const store = new ComposioStore(dir)
  const cli = new ComposioCli({ outputDir: join(dir, 'outputs') })
  const api = new ComposioApi()
  const service = new ComposioService(cli, api, new ToolkitCatalog(api, join(dir, 'toolkits.json')))
  const svc = ctx as unknown as Services
  const get = <T>(key: string): T | undefined => (ctx as unknown as { get(k: string): T | undefined }).get(key)

  // ---------- trigger-run policy + approval gate ----------
  const runPolicies = new Map<string, RunPolicy>()
  const events = ctx as unknown as { on(name: string, listener: (...args: never[]) => unknown, options?: unknown): () => void }
  ctx.effect(() => events.on('tools/pre-execute', (async (exec: { name: string; arguments: unknown; agent?: { id: string } }, next: () => Promise<{ kind: string }>) => {
    const decision = await next()
    if (decision.kind !== 'allow' || exec.name !== 'composio_execute') return decision
    const args = (typeof exec.arguments === 'object' && exec.arguments !== null ? exec.arguments : {}) as Json
    if (args['get_schema'] === true || args['dry_run'] === true) return decision
    const slug = typeof args['slug'] === 'string' ? args['slug'] : ''
    if (slug === '') return decision
    const g = gate({ slug, risk: await service.riskOfSlug(slug), policy: exec.agent === undefined ? undefined : runPolicies.get(exec.agent.id) })
    return g.kind === 'allow' ? decision : { kind: 'ask', reason: g.reason, displayReason: { en: g.reason } }
  }) as never), 'composio: approval gate')

  // ---------- model selection ----------
  const automation = (): { applyTo(agent: unknown, route: ModelRoute, o?: { restore?: 'idle' | 'never' }): boolean } | undefined => get('automationModels')

  // ---------- launcher ----------
  const launcher = new RunLauncher({
    controller: () => get<SessionControllerLike>('sessionController'),
    liveAgent: (id) => svc.agents.get(id),
    archived: (id) => (get<{ archivedSessionIds: readonly string[] }>('workspaceRegistry')?.archivedSessionIds ?? []).includes(id),
    makeMessage: (text, pinned) => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'composio', ...(pinned ? { pinned: true } : {}) } }),
    flush: (agent) => svc.sessions.flush(agent.session),
    rename: (agent, title) => { get<{ rename(s: unknown, t: string): unknown }>('sessionTitle')?.rename(agent.session, title) },
    attachWorkspace: async (sessionId, cwd) => {
      const registry = get<{ resolveByPath(p: string): Promise<{ attachSession(id: string): Promise<void> } | undefined> }>('workspaceRegistry')
      if (registry === undefined || cwd === undefined) return
      try { await (await registry.resolveByPath(cwd))?.attachSession(sessionId) } catch (error) { log.warn(`composio: workspace attach failed: ${String(error)}`) }
    },
    applyModel: (agent, route, restore) => {
      const am = automation()
      if (am !== undefined) return am.applyTo(agent, route, { restore })
      if (restore === 'never') { agent.model.select(route); return true } // new session: nothing to restore
      return false // an existing session without dsh-automation-models: never leave its model changed
    },
    restrictRun: (agent, recipe) => {
      runPolicies.set(agent.id, { allowTools: recipe.allowTools, allowToolkits: recipe.allowToolkits })
      agent.ctx.effect(() => agent.ctx.tools.guard(runToolGuard), 'composio: trigger-run tool guard')
      agent.ctx.effect(() => () => { runPolicies.delete(agent.id) }, 'composio: policy cleanup')
    },
    pinTurn: (agent, policy) => { pins.apply(agent as unknown as PinnableAgent, agent.id, policy) },
    log,
  })
  const pins = new TurnPins({
    currentMode: (agent) => { try { return get<{ resolve(r: { session: unknown }): { mode?: string } }>('sandboxPolicy')?.resolve({ session: agent.session }).mode } catch { return undefined } },
    guard: runToolGuard,
    setRunPolicy: (id, policy) => { if (policy === undefined) runPolicies.delete(id); else runPolicies.set(id, policy) },
    persist: new PinStore(join(dir, 'pins.json')),
    log,
  })
  // A human turn lifts the pin; a session loaded with a pin left over from an earlier process is restored.
  ctx.effect(() => events.on('agent/inbox/claimed', ((p: { agent: PinnableAgent; message: { source?: { kind?: string } } }) => { pins.onClaimed(p.agent, p.message) }) as never), 'composio: lift pin on human turn')
  ctx.effect(() => events.on('agent/created', ((p: { agent: PinnableAgent & { id: string } }) => { pins.onCreated(p.agent, p.agent.id) }) as never), 'composio: restore stale pin')
  void pins.load()

  // ---------- router ----------
  const seen = new Set<string>()
  const remember = (id: string): boolean => { if (seen.has(id)) return false; seen.add(id); if (seen.size > 2000) { const first = seen.values().next().value; if (first !== undefined) seen.delete(first) } return true }
  const bytesOf = (e: NormalizedEvent): number => JSON.stringify(e.data).length
  const row = (r: Route, recipeId: string, e: NormalizedEvent, status: RunRow['status'], extra: Partial<RunRow> = {}): RunRow => ({
    runId: newId('run'), at: Date.now(), routeId: r.id, routeName: r.name, recipeId, mode: r.target.mode,
    event: { id: e.eventId, slug: e.triggerSlug, toolkit: e.toolkit, bytes: bytesOf(e) }, status, ...extra,
  })

  /** dsh-triggers (optional): automations with a Composio source get every event; they own their own log and limits. */
  const triggers = (): { ingest(e: { source: 'composio'; triggerSlug: string; triggerInstanceId?: string; eventId: string; data: Record<string, unknown> }): Promise<{ matched: number }> } | undefined => get('triggers')

  async function onEvent(event: NormalizedEvent): Promise<void> {
    if (!remember(event.eventId)) return // duplicate
    let viaTriggers = 0
    const t = triggers()
    if (t !== undefined) {
      try { viaTriggers = (await t.ingest({ source: 'composio', triggerSlug: event.triggerSlug, triggerInstanceId: event.triggerId, eventId: event.eventId, data: event.data })).matched }
      catch (error) { log.warn(`composio: triggers ingest failed: ${String(error)}`) }
    }
    const matching = store.data.routes.filter((r) => r.triggerInstanceId === event.triggerId)
    if (matching.length === 0) {
      if (viaTriggers === 0) log.warn(`composio: no route or Triggers automation for event ${event.eventId.slice(0, 12)} (trigger ${event.triggerId.slice(0, 12)})`)
      return
    }
    for (const r of matching) {
      const recipe = store.data.recipes.find((x) => x.id === r.recipeId)
      if (recipe === undefined) { await store.log(row(r, r.recipeId, event, 'skipped', { reason: 'recipe-missing' })); continue }
      if (!r.enabled) { await store.log(row(r, recipe.id, event, 'skipped', { reason: 'route-disabled' })); continue }
      if (store.data.paused) { await store.log(row(r, recipe.id, event, 'skipped', { reason: 'paused' })); continue }
      const limited = rateDecision(store, r, Date.now())
      if (limited !== undefined) { await store.log(row(r, recipe.id, event, 'skipped', { reason: limited })); continue }
      try {
        const result = await ctx.agents.withoutInitiator(async () => (r.target.mode === 'new-session'
          ? launcher.launchNew(recipe, r, event)
          : launcher.launchExisting(recipe, r as Route & { target: { mode: 'existing-session'; sessionId: string } }, event)))
        r.consecutiveFailures = 0
        const queued = 'queued' in result && result.queued === true
        await store.log(row(r, recipe.id, event, queued ? 'queued' : 'delivered', { sessionId: result.sessionId, ...(result.model === undefined ? {} : { model: result.model }) }))
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        r.consecutiveFailures += 1
        if (r.consecutiveFailures >= 3) { r.enabled = false; log.warn(`composio: route ${r.name} disabled after 3 consecutive failures`) }
        await store.log(row(r, recipe.id, event, 'failed', { error: message.slice(0, 300) }))
        void store.save()
      }
    }
  }

  const listener = new TriggerListener({
    api, leasePath: join(dir, 'listener.lease'), log,
    onEvent: (e) => { void onEvent(e).catch((error: unknown) => { log.warn(`composio: router failed: ${String(error)}`) }) },
  })

  // ---------- agents: tools + queue flush ----------
  const attached = new WeakSet<object>()
  ctx.effect(() => events.on('agent/created', ((p: { agent: AgentLike }) => {
    try {
      const agent = p.agent
      if (attached.has(agent) || agent.session.header?.origin === 'subagent') return
      attached.add(agent)
      agent.ctx.effect(() => {
        const disposers = composioTools(service).map((tool) => (agent.ctx as unknown as { tools: { register(d: unknown): () => void } }).tools.register(tool))
        const stop = (agent.ctx as unknown as { on(n: string, l: (...a: never[]) => void): () => void }).on('agent/status', ((s: { status: string }) => { if (s.status === 'idle') launcher.flushQueue(agent.id, agent) }) as never)
        return () => { stop(); for (const d of disposers) d() }
      }, 'composio: tools')
    } catch (error) { log.warn(`composio: could not attach tools: ${String(error)}`) }
  }) as never), 'composio: agent hook')

  // ---------- service for dsh-triggers ----------
  // Triggers automations with a Composio source create/remove their trigger instance through this. Routes on the
  // Composio page and Triggers automations can share one instance (Composio de-duplicates identical configs), so an
  // instance is deleted only when neither side still uses it.
  ctx.provide('composio', {
    /** Connected accounts per toolkit (for pickers). */
    connections: () => service.connections(),
    /** Trigger types a toolkit offers. */
    triggerTypes: (toolkit: string) => api.triggerTypes(toolkit),
    /** Create (upsert) a trigger instance; returns its `ti_*` id. */
    ensureTrigger: (slug: string, connectedAccountId: string, config: Record<string, unknown> = {}) => api.createTrigger(slug, connectedAccountId, config),
    /** Delete a trigger instance unless a Composio-page route still uses it. */
    releaseTrigger: async (instanceId: string) => { if (!instanceStillUsed(store.data.routes, instanceId)) await api.deleteTrigger(instanceId) },
    setTriggerEnabled: (instanceId: string, enabled: boolean) => api.setTriggerStatus(instanceId, enabled ? 'enable' : 'disable'),
    /** Listener state, so Triggers can warn when events cannot arrive. */
    listenerState: () => listener.current,
  })

  // ---------- automation-models source ----------
  ctx.inject(['automationModels'], (c: Context) => {
    const am = (c as unknown as { automationModels: { registerSource(kind: string, spec: unknown): () => void } }).automationModels
    c.effect(() => am.registerSource('composio', {
      label: 'Composio triggers',
      keyOf: (m: { source: { routeId?: string } }) => m.source.routeId,
      isRun: (m: { source: { pinned?: boolean } }) => m.source.pinned !== true, // a recipe that pins its model is not overridden
    }), 'composio: automation-models source')
  })

  // ---------- lifecycle ----------
  let stopped = false
  void store.load().then(async () => {
    for (const id of store.seenEventIds()) seen.add(id)
    if (stopped) return
    try { readCreds(); await listener.start(); log.info('composio: ready') } catch (error) {
      if (error instanceof CredsError) log.warn(`composio: listener not started: ${error.message}`)
      else log.warn(`composio: listener failed to start: ${String(error)}`)
    }
  })
  ctx.effect(() => () => { stopped = true; void listener.stop() }, 'composio: listener')

  // ---------- routes ----------
  async function state(): Promise<unknown> {
    const [health, accounts] = await Promise.all([service.health(), service.connections().catch(() => undefined)])
    const active = await api.activeTriggers().catch(() => undefined)
    const known = new Set(store.data.routes.map((r) => r.triggerInstanceId))
    return {
      health, listener: listener.current, paused: store.data.paused, queued: launcher.queued,
      hasAutomationModels: automation() !== undefined,
      connections: accounts ?? null,
      recipes: store.data.recipes, routes: store.data.routes,
      orphanTriggers: (active ?? []).filter((t) => !known.has(t.id)).map((t) => ({ id: t.id, slug: t.slug })),
      runs: store.recentRuns(60),
    }
  }

  const recipeFrom = (body: Json, prior?: Recipe): Recipe | string => {
    const nameText = str(body['name'], 120); const template = str(body['promptTemplate'], 20_000)
    if (nameText === undefined) return 'name is required'
    if (template === undefined) return 'promptTemplate is required'
    const sandbox = body['sandbox'] === 'workspace-write' ? 'workspace-write' : 'read-only'
    const payload = (typeof body['payload'] === 'object' && body['payload'] !== null ? body['payload'] : {}) as Json
    const now = Date.now()
    return {
      id: prior?.id ?? newId('rcp'), name: nameText, promptTemplate: template,
      cwd: str(body['cwd'], 1000), agentPreset: str(body['agentPreset'], 100), model: route(body['model']),
      allowToolkits: strList(body['allowToolkits']), allowTools: strList(body['allowTools']), sandbox,
      payload: { ...(typeof payload['maxChars'] === 'number' ? { maxChars: Math.min(Math.max(payload['maxChars'], 200), 50_000) } : {}), ...(Array.isArray(payload['include']) ? { include: strList(payload['include']) } : {}) },
      sessionTitle: str(body['sessionTitle'], 120), createdAt: prior?.createdAt ?? now, updatedAt: now,
    }
  }
  const WRITEY = /(SEND|POST|COMMENT|REPLY|CREATE|DELETE|UPDATE|MERGE|REMOVE|PUBLISH)/
  const lint = (r: Recipe): string[] => r.allowTools.filter((t) => WRITEY.test(t)).map((t) => `${t} can write to an external service while the trigger carries third-party text: prompt injection could steer it. Keep it only if you accept that; runs still ask before destructive tools.`)

  async function handle(method: string, body: Json): Promise<Response> {
    switch (method) {
      case 'state': return ok(await state())
      case 'tools': { const toolkit = str(body['toolkit'], 64); if (toolkit === undefined) return fail('bad-request', 'toolkit is required'); return ok(await service.tools(toolkit, str(body['query'], 100), 60)) }
      case 'schema': { const slug = str(body['slug'], 120); if (slug === undefined) return fail('bad-request', 'slug is required'); return ok(await service.schema(slug)) }
      case 'dryRun': { const slug = str(body['slug'], 120); if (slug === undefined) return fail('bad-request', 'slug is required'); return ok(await service.execute(slug, body['arguments'] ?? {}, { dryRun: true })) }
      case 'link': { const toolkit = str(body['toolkit'], 64); if (toolkit === undefined) return fail('bad-request', 'toolkit is required'); return ok(await service.link(toolkit, str(body['alias'], 64))) }
      case 'triggerTypes': { const toolkit = str(body['toolkit'], 64); if (toolkit === undefined) return fail('bad-request', 'toolkit is required'); return ok(await api.triggerTypes(toolkit)) }
      case 'setPaused': store.data.paused = body['paused'] === true; await store.save(); return ok(await state())
      case 'saveRecipe': {
        const prior = typeof body['id'] === 'string' ? store.data.recipes.find((r) => r.id === body['id']) : undefined
        const built = recipeFrom(body, prior)
        if (typeof built === 'string') return fail('bad-request', built)
        store.data.recipes = [...store.data.recipes.filter((r) => r.id !== built.id), built]
        await store.save()
        return ok({ recipe: built, warnings: lint(built) })
      }
      case 'deleteRecipe': {
        const id = str(body['id'], 100)
        if (store.data.routes.some((r) => r.recipeId === id)) return fail('in-use', 'A route still uses this recipe.')
        store.data.recipes = store.data.recipes.filter((r) => r.id !== id); await store.save(); return ok(await state())
      }
      case 'createRoute': {
        const triggerSlug = str(body['triggerSlug'], 120); const accountId = str(body['connectedAccountId'], 80); const recipeId = str(body['recipeId'], 100)
        if (triggerSlug === undefined || accountId === undefined || recipeId === undefined) return fail('bad-request', 'triggerSlug, connectedAccountId and recipeId are required')
        if (!store.data.recipes.some((r) => r.id === recipeId)) return fail('bad-request', 'unknown recipe')
        const target: Route['target'] = body['targetSessionId'] === undefined || body['targetSessionId'] === '' ? { mode: 'new-session' as const } : { mode: 'existing-session' as const, sessionId: str(body['targetSessionId'], 200) ?? '', acknowledged: body['acknowledgeRisk'] === true }
        if (target.mode === 'existing-session' && target.sessionId === '') return fail('bad-request', 'invalid target session')
        // CO-1: waking a live session with third-party text is opt-in per route.
        if (target.mode === 'existing-session' && target.acknowledged !== true) return fail('needs-acknowledgement', 'Waking an existing session feeds untrusted trigger text to it. Acknowledge the risk to create this route.')
        const config = (typeof body['triggerConfig'] === 'object' && body['triggerConfig'] !== null ? body['triggerConfig'] : {}) as Record<string, unknown>
        const triggerInstanceId = await api.createTrigger(triggerSlug, accountId, config)
        const created: Route = {
          id: newId('rt'), name: str(body['name'], 120) ?? triggerSlug, enabled: true, triggerSlug, toolkit: triggerSlug.split('_')[0]?.toLowerCase() ?? '',
          connectedAccountId: accountId, triggerConfig: config, triggerInstanceId, recipeId, target, limits: { ...DEFAULT_LIMITS }, consecutiveFailures: 0, createdAt: Date.now(),
        }
        store.data.routes.push(created); await store.save(); return ok(await state())
      }
      case 'setRouteEnabled': {
        const r = store.data.routes.find((x) => x.id === body['id']); if (r === undefined) return fail('not-found', 'unknown route')
        const enabled = body['enabled'] === true
        // A shared instance stays enabled while any route on it is enabled.
        const instanceEnabled = enabled || store.data.routes.some((x) => x.id !== r.id && x.triggerInstanceId === r.triggerInstanceId && x.enabled)
        await api.setTriggerStatus(r.triggerInstanceId, instanceEnabled ? 'enable' : 'disable').catch((e: unknown) => { log.warn(`composio: trigger status change failed: ${String(e)}`) })
        r.enabled = enabled; if (enabled) r.consecutiveFailures = 0; await store.save(); return ok(await state())
      }
      case 'acknowledgeRoute': {
        const r = store.data.routes.find((x) => x.id === body['id']); if (r === undefined) return fail('not-found', 'unknown route')
        if (r.target.mode !== 'existing-session') return fail('bad-request', 'only existing-session routes need an acknowledgement')
        r.target.acknowledged = body['acknowledged'] === true
        await store.save(); return ok(await state())
      }
      case 'deleteRoute': {
        const r = store.data.routes.find((x) => x.id === body['id']); if (r === undefined) return fail('not-found', 'unknown route')
        // Composio de-duplicates identical trigger configs into ONE instance, so routes can share it: delete the remote
        // instance only with its last route (and never while another route is merely disabled).
        store.data.routes = store.data.routes.filter((x) => x.id !== r.id)
        if (!instanceStillUsed(store.data.routes, r.triggerInstanceId)) await api.deleteTrigger(r.triggerInstanceId)
        await store.save(); return ok(await state())
      }
      case 'sessions': {
        const controller = get<{ list(r: unknown, s: AbortSignal): Promise<{ items: { sessionId: string; cwd?: string; origin?: string; running: boolean }[] }> }>('sessionController')
        if (controller === undefined) return ok([])
        const list = await controller.list({}, new AbortController().signal)
        return ok(list.items.filter((i) => i.origin !== 'subagent').slice(0, 100).map((i) => ({ id: i.sessionId, cwd: i.cwd ?? null, running: i.running })))
      }
      case 'models': {
        const controller = get<{ modelCatalog(): Promise<unknown> }>('sessionController')
        return ok(controller === undefined ? null : await controller.modelCatalog())
      }
      default: return fail('not-found', `Unknown method "${method}".`, 404)
    }
  }

  ctx.inject(['connection'], (c: Context) => {
    const connection = (c as unknown as { connection: { fetch: { register(r: unknown): () => Promise<void> }; requestRejection(r: Peerish): number | undefined } }).connection
    for (const method of ['state', 'tools', 'schema', 'dryRun', 'link', 'triggerTypes', 'setPaused', 'saveRecipe', 'deleteRecipe', 'createRoute', 'acknowledgeRoute', 'setRouteEnabled', 'deleteRoute', 'sessions', 'models']) {
      c.effect(() => connection.fetch.register({
        path: `${API}/${method}`, methods: ['POST'], requestBody: 'buffered',
        fetch: async (request: Request) => {
          // Fail closed: re-check admission and require same-origin on every call.
          let rejection: number | undefined
          try { rejection = connection.requestRejection(request) } catch { rejection = 503 }
          if (rejection !== undefined) return fail(rejection === 401 ? 'unauthorized' : 'forbidden', 'rejected', rejection)
          if (!sameOrigin(request.headers)) return fail('origin-rejected', 'cross-origin request rejected', 403)
          let body: Json = {}
          try { const parsed = await request.json() as unknown; if (typeof parsed === 'object' && parsed !== null) body = parsed as Json } catch { return fail('bad-request', 'Body is not JSON') }
          try { return await handle(method, body) } catch (error) {
            if (error instanceof ApiError || error instanceof CredsError) return fail('composio', error.message)
            const message = error instanceof Error ? error.message : String(error)
            log.warn(`composio: ${method} failed: ${message.slice(0, 200)}`)
            return fail('failed', message.slice(0, 300))
          }
        },
      }), `composio: ${method} route`)
    }
  })
}
