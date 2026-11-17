/**
 * Host half of Automation models.
 *  - Service `automationModels` (registerSource / resolveFor / applyTo / listSources) for other plugins;
 *  - global `agent/inbox/claimed` + `agent/status` + `agent/created` listeners that switch a session's model for the
 *    duration of an automation turn (schedule, sentinel, or any registered source) and restore it afterwards;
 *  - own storage-domain for per-source defaults, per-task overrides and crash-restore markers;
 *  - POST routes /api/automation-models/* for the "Automation models" page (fail closed, same-origin for writes).
 * Never calls sessionController.selectModel (that rewrites the profile's global default model).
 */
import type { Context } from '@deepseek-ai/cordis'
import {
  AutomationModelsCore, BUILTIN_DEFAULT, routeLabel,
  type AgentLike, type MessageLike, type Resolution, type Route, type SourceSpec,
} from './host/core.ts'
import { AutomationStore, automationDomain, parseRoute, type DomainFace } from './host/store.ts'

export const name = 'dsh-automation-models'
export const inject = ['agents', 'storageDomain']

export const API = '/api/automation-models'

export type { Route, SourceSpec, Resolution, MessageLike, AgentLike }
export { BUILTIN_DEFAULT }

/** The public host service other plugins use (`ctx.automationModels`, or `ctx.get('automationModels')`). */
export class AutomationModelsService {
  constructor(private readonly ctx: Context, private readonly core: AutomationModelsCore) {}
  /** Declare an automation message source. Its messages (source.kind === kind) run on the resolved route. Returns a disposer. */
  registerSource(kind: string, spec: SourceSpec): () => void {
    const dispose = this.core.registerSource(kind, spec)
    this.ctx.effect(() => dispose, `automation-models: source ${kind}`)
    return dispose
  }
  /** Which route would this message run on? undefined = stays on the session's own model. */
  resolveFor(message: MessageLike): Resolution | undefined { return this.core.resolveFor(message) }
  /**
   * Route for a source that runs its own LLM calls rather than delivering messages (e.g. the skill reviewer):
   * per-item override (when `key` is given), then the stored source default, the source's defaultRoute, the built-in default.
   * undefined = the user chose "session's own model" for this source/item, or the source is unknown.
   */
  resolve(kind: string, key?: string): Route | undefined {
    const source = this.core.getSource(kind)
    if (source === undefined) return undefined
    return this.core.resolveKind(source, key)?.route
  }
  /** Switch `agent` to `route` for the current turn and restore it when the agent goes idle. */
  applyTo(agent: AgentLike, route: Route, options?: { restore?: 'idle' | 'never' }): boolean { return this.core.applyTo(agent, route, options) }
  listSources(): { kind: string; label: string; builtin: boolean }[] { return this.core.listSources().map(({ kind, label, builtin }) => ({ kind, label, builtin })) }
}

declare module '@deepseek-ai/cordis' {
  interface Context { automationModels: AutomationModelsService }
}

type Json = Record<string, unknown>
interface Peerish { headers: Headers }
interface ModelCatalogLike { default: Route; groups: { id: string; name: string; models: { id: string; name: string; reasoning?: { efforts: { id: string; name: string }[]; defaultEffort?: string } }[] }[] }
interface ScheduleEntryLike { id: string; title: string; kind: string; status: string; target: { kind: string }; scheduledAt?: string; everySeconds?: number; expression?: string; time?: string }

const ok = (value: unknown): Response => Response.json({ ok: true, value }, { headers: { 'cache-control': 'no-store' } })
const fail = (code: string, message: string, status = 200): Response => Response.json({ ok: false, error: { code, message } }, { status, headers: { 'cache-control': 'no-store' } })

/** Mutations must come from the page itself: an Origin header, when present, has to name this host. */
export function sameOrigin(headers: Headers): boolean {
  const origin = headers.get('origin')
  if (origin === null) return true
  const host = headers.get('host')
  try { return host !== null && new URL(origin).host === host } catch { return false }
}

const timingOf = (entry: ScheduleEntryLike): string => {
  if (entry.kind === 'every' && entry.everySeconds !== undefined) return entry.everySeconds % 60 === 0 ? `every ${String(entry.everySeconds / 60)} min` : `every ${String(entry.everySeconds)} s`
  if (entry.kind === 'cron' && entry.expression !== undefined) return `cron ${entry.expression}`
  if (entry.kind === 'daily' && entry.time !== undefined) return `daily ${entry.time}`
  return entry.kind
}

export function apply(ctx: Context): void {
  const log = { info: (m: string) => { ctx.logger.info(m) }, warn: (m: string) => { ctx.logger.warn(m) } }
  const store = new AutomationStore()

  // --- model availability cache (so an unavailable override falls back instead of failing at request time) ---
  const available = new Map<string, Set<string>>()
  let providersLoaded = false
  const llm = (): { listProviders(): { id: string }[]; listModels(p: string): Promise<{ id: string }[]> } | undefined => ctx.get('llm' as never) as never
  const refreshModels = async (): Promise<void> => {
    const service = llm()
    if (service === undefined) return
    try {
      const providers = service.listProviders()
      const next = new Map<string, Set<string>>()
      await Promise.all(providers.map(async (provider) => {
        try { next.set(provider.id, new Set((await service.listModels(provider.id)).map((m) => m.id))) } catch { /* unknown: leave out, treated as available */ }
      }))
      available.clear()
      for (const [k, v] of next) available.set(k, v)
      providersLoaded = true
      knownProviders = new Set(providers.map((p) => p.id))
    } catch (error) { log.warn(`automation-models: model refresh failed: ${String(error)}`) }
  }
  let knownProviders = new Set<string>()
  const isAvailable = (route: Route): boolean | undefined => {
    if (!providersLoaded) return undefined
    if (!knownProviders.has(route.provider)) return false
    const models = available.get(route.provider)
    return models === undefined ? undefined : models.has(route.model)
  }

  const core = new AutomationModelsCore({ store, available: isAvailable, log })
  // A plain object provided on the context: no second copy of cordis' Service class is needed, and the
  // registration leaves with this plugin's fiber.
  ctx.provide('automationModels', new AutomationModelsService(ctx, core))

  const events = ctx as unknown as { on(name: string, listener: (...args: never[]) => void): () => void }
  ctx.effect(() => events.on('agent/inbox/claimed', ((p: { agent: AgentLike; message: MessageLike; turn: number }) => { core.onClaimed(p.agent, p.message, p.turn) }) as never), 'automation-models: claimed hook')
  ctx.effect(() => events.on('agent/status', ((p: { agent: AgentLike; status: string }) => { core.onStatus(p.agent, p.status) }) as never), 'automation-models: idle restore')
  ctx.effect(() => events.on('agent/created', ((p: { agent: AgentLike; source: string }) => { core.onCreated(p.agent, p.source) }) as never), 'automation-models: crash restore')
  ctx.effect(() => events.on('agent/disposed', ((p: { agent: AgentLike }) => { core.onDisposed(p.agent) }) as never), 'automation-models: dispose')
  ctx.effect(() => events.on('llm/models-updated', (() => { void refreshModels() }) as never), 'automation-models: models updated')
  ctx.effect(() => events.on('llm/adapters-updated', (() => { void refreshModels() }) as never), 'automation-models: adapters updated')

  // --- storage + cleanup of overrides whose task is gone ---
  let domain: DomainFace | undefined
  const scheduleCatalog = async (): Promise<ScheduleEntryLike[] | undefined> => {
    const schedule = ctx.get('schedule' as never) as { catalog(): Promise<ScheduleEntryLike[]> } | undefined
    if (schedule === undefined) return undefined
    try { return await schedule.catalog() } catch { return undefined }
  }
  let pruning: ReturnType<typeof setTimeout> | undefined
  const prune = (): void => {
    if (pruning !== undefined) clearTimeout(pruning)
    pruning = setTimeout(() => {
      pruning = undefined
      void scheduleCatalog().then((catalog) => (catalog === undefined ? 0 : store.pruneOverrides('schedule', new Set(catalog.map((e) => e.id))))).catch(() => 0)
    }, 2000)
  }
  ctx.effect(() => () => { if (pruning !== undefined) clearTimeout(pruning) }, 'automation-models: prune timer')
  ctx.effect(() => events.on('schedule/changed', (() => { prune() }) as never), 'automation-models: schedule changed')

  const storage = (ctx as unknown as { storageDomain: { open(spec: unknown): Promise<DomainFace> } }).storageDomain
  let closed = false
  void storage.open(automationDomain).then((opened) => {
    if (closed) { void opened.close().catch(() => {}); return }
    domain = opened
    store.attach(opened)
    log.info('automation-models: ready')
    void refreshModels()
    prune()
  }).catch((error: unknown) => { log.warn(`automation-models: storage unavailable, staying inactive: ${String(error)}`) })
  ctx.effect(() => () => { closed = true; store.detach(); void domain?.close().catch(() => {}) }, 'automation-models: storage')

  // --- model catalog for the page (cached; the page asks rarely) ---
  let catalogCache: { at: number; value: ModelCatalogLike } | undefined
  const modelCatalog = async (): Promise<ModelCatalogLike | undefined> => {
    if (catalogCache !== undefined && Date.now() - catalogCache.at < 30_000) return catalogCache.value
    const controller = ctx.get('sessionController' as never) as { modelCatalog(): Promise<ModelCatalogLike> } | undefined
    if (controller === undefined) return undefined
    try { catalogCache = { at: Date.now(), value: await controller.modelCatalog() }; return catalogCache.value } catch { return undefined }
  }
  ctx.effect(() => events.on('llm/models-updated', (() => { catalogCache = undefined }) as never), 'automation-models: catalog cache')

  const agentDefault = (): Route | undefined => (ctx.get('agentDefaultModel' as never) as { currentSelection(): Route } | undefined)?.currentSelection()

  async function state(): Promise<unknown> {
    const catalog = await modelCatalog()
    const tasks = (await scheduleCatalog()) ?? []
    const sources = core.listSources().map((s) => {
      const stored = store.getDefault(s.kind)
      const effective = stored === undefined ? (s.defaultRoute ?? BUILTIN_DEFAULT) : stored.route
      return {
        kind: s.kind, label: s.label, builtin: s.builtin,
        stored: stored === undefined ? 'inherit' : stored.route === null ? 'session' : 'route',
        route: stored?.route ?? null,
        pluginDefault: s.defaultRoute ?? null,
        effective,
        effectiveAvailable: effective === null ? true : isAvailable(effective) !== false,
      }
    })
    return {
      enabled: store.enabled(), ready: store.ready, builtinDefault: BUILTIN_DEFAULT, sessionDefault: agentDefault() ?? null,
      sources,
      tasks: tasks.map((t) => {
        const override = store.getOverride('schedule', t.id)
        return {
          id: t.id, title: t.title, status: t.status, timing: timingOf(t), target: t.target.kind,
          override: override === undefined ? 'inherit' : override.route === null ? 'session' : 'route',
          route: override?.route ?? null, keep: override?.keep === true,
        }
      }),
      catalog: catalog === undefined ? null : {
        groups: catalog.groups.map((g) => ({
          id: g.id, name: g.name,
          models: g.models.map((m) => ({ id: m.id, name: m.name, efforts: m.reasoning?.efforts.map((e) => ({ id: e.id, name: e.name })) ?? [], defaultEffort: m.reasoning?.defaultEffort ?? null })),
        })),
      },
      notices: core.recentNotices(),
    }
  }

  const routeIn = (body: Json, key: string): Route | null | undefined => {
    const value = body[key]
    if (value === undefined) return undefined
    return value === null ? null : parseRoute(value)
  }

  async function handle(method: string, body: Json): Promise<Response> {
    if (!store.ready && method !== 'state') return fail('not-ready', 'Storage is still opening; try again in a moment.')
    switch (method) {
      case 'state': return ok(await state())
      case 'setEnabled': {
        if (typeof body['enabled'] !== 'boolean') return fail('bad-request', 'enabled must be a boolean')
        await store.setEnabled(body['enabled']); return ok(await state())
      }
      case 'setDefault': {
        const kind = body['kind']
        if (typeof kind !== 'string' || core.getSource(kind) === undefined) return fail('bad-request', 'unknown source')
        // route: object = use it, null = keep the session's own model, absent = back to the plugin/built-in default.
        await store.setDefault(kind, routeIn(body, 'route'))
        return ok(await state())
      }
      case 'setOverride': {
        const kind = body['kind']; const key = body['key']
        if (typeof kind !== 'string' || typeof key !== 'string' || key.length === 0 || key.length > 200) return fail('bad-request', 'kind and key are required')
        const route = routeIn(body, 'route')
        await store.setOverride(kind, key, route === undefined ? undefined : { route, ...(body['keep'] === true ? { keep: true } : {}) })
        return ok(await state())
      }
      default: return fail('not-found', `Unknown method "${method}".`, 404)
    }
  }

  ctx.inject(['connection'], (c: Context) => {
    const connection = (c as unknown as { connection: { fetch: { register(r: unknown): () => Promise<void> }; requestRejection(r: Peerish): number | undefined } }).connection
    for (const method of ['state', 'setEnabled', 'setDefault', 'setOverride']) {
      c.effect(() => connection.fetch.register({
        path: `${API}/${method}`,
        methods: ['POST'],
        requestBody: 'buffered',
        fetch: async (request: Request) => {
          // Fail closed: re-check admission and require same-origin on every call.
          let rejection: number | undefined
          try { rejection = connection.requestRejection(request) } catch { rejection = 503 }
          if (rejection !== undefined) return fail(rejection === 401 ? 'unauthorized' : 'forbidden', 'rejected', rejection)
          if (!sameOrigin(request.headers)) return fail('origin-rejected', 'cross-origin request rejected', 403)
          let body: Json = {}
          try { const parsed = await request.json() as unknown; if (typeof parsed === 'object' && parsed !== null) body = parsed as Json } catch { return fail('bad-request', 'Body is not JSON') }
          try { return await handle(method, body) } catch (error) {
            if (error instanceof Error && /route needs|reasoningEffort/.test(error.message)) return fail('bad-request', error.message)
            log.warn(`automation-models: ${method} failed: ${error instanceof Error ? error.message : String(error)}`)
            return fail('internal', 'Something went wrong; see the host log.')
          }
        },
      }), `automation-models: ${method} route`)
    }
  })

  log.info(`automation-models: loaded (default ${routeLabel(BUILTIN_DEFAULT)})`)
}
