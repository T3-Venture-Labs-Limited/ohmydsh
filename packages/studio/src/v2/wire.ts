/** Wires the v2 core into a running DSH host: adapters, credentials, routes, boot resume, tools. */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import type { Config } from '../config.js'
import { resolveOpenAICompatChannels, activeComfyUIWorkflow, resolveComfyUIWorkflows, DEFAULT_COMFYUI_BASE_URL, DEFAULT_COMFYUI_TIMEOUT_MS, DEFAULT_GOOGLE_MODEL, DEFAULT_OPENAI_BASE_URL, DEFAULT_OPENAI_MODEL, DEFAULT_XAI_BASE_URL, DEFAULT_XAI_MODEL } from '../shared.js'
import type { SubscriptionManager } from '../subscription.js'
import { createCore, DB_FILE, type StudioCore } from './core.js'
import { OpenRouterAdapter } from './providers/openrouter.js'
import { ReplicateAdapter } from './providers/replicate.js'
import { ComfyUIAdapter, CompatAdapter, SubscriptionAdapter, type CompatEndpoint } from './providers/legacy.js'
import { GoogleDirectAdapter } from './providers/google.js'
import { createV2Handler, ROUTE_BASE } from './routes/index.js'
import { HyperframesManager } from './hyperframes/launcher.js'
import { registerV2Tools } from './tools/tools.js'
import type { AssetRecord, ProviderId } from './contracts.js'
import { resolveReferenceImages } from '../reference-image.js'
import { saveImageToWorkspace } from '../workspace-save.js'
import { AgentCapture } from './agent-capture.js'
import { BACKFILL_KEY, readBackfillMarker, runBackfill, type BackfillSummary, type SessionHistory } from './agent-backfill.js'
import type { AgentMediaApi } from './routes/agent-media.js'

export const OPENROUTER_KEY_REF = 'OPENROUTER_API_KEY'
export const REPLICATE_KEY_REF = 'REPLICATE_API_TOKEN'
export const GOOGLE_KEY_REF = 'GEMINI_API_KEY'

export interface WireOptions {
  /** Remember session workspaces so the legacy cleanup knows where files were saved. */
  rememberWorkspace?(root: string): void
  config(): Config
  subscriptionManager: SubscriptionManager
  admission(): ((request: never) => unknown) | undefined
  withAdmission(route: WebRoute): WebRoute
  home?: string
}

/** Resolve a key from DSH credentials (stored value outranks env), then the process environment. Never logged. */
export async function resolveKey(ctx: Context, ref: string): Promise<string | undefined> {
  // A relay key stored by the old plugin lives under DSH_IMAGE_GEN_*: honour it when the DSH_STUDIO_* one has not been entered yet,
  // so retiring dsh-image-gen does not silently drop a configured OpenAI-compatible channel.
  const candidates = ref.startsWith('DSH_STUDIO_') ? [ref, ref.replace(/^DSH_STUDIO_/, 'DSH_IMAGE_GEN_')] : [ref]
  for (const name of candidates) {
    try {
      const credential = await ctx.credentials.resolve(credentialRef(name))
      const value = credential?.value.trim() ?? ''
      if (value.length > 0) return value
    } catch { /* fall through */ }
    const env = process.env[name]?.trim()
    if (env !== undefined && env.length > 0) return env
  }
  return undefined
}

/** Loose faces of the host services the agent capture reads. All optional: without them capture still works, just with less provenance. */
interface SessionLike { id: string; header?: { cwd?: string } }
interface SessionQueryLike {
  listSessions(): Promise<{ header: { id: string; cwd?: string } }[]>
  readSession(id: string): Promise<{ session: { cwd?: string }; events: readonly { type: string; time?: number; data?: unknown }[] }>
  readTitle?(id: string): Promise<{ title?: string } | undefined>
}

export function wireV2(ctx: Context, options: WireOptions): StudioCore {
  // Lazy: the database file is only created when something first needs it (a route, a tool or the boot resume).
  const core = createCore({ ...(options.home === undefined ? {} : { home: options.home }), runner: { logger: ctx.logger }, lazy: true })
  const { registry } = core
  core.keys = ref => resolveKey(ctx, ref)
  const cfg = (): Config => options.config()

  registry.register(new OpenRouterAdapter({
    apiKey: () => resolveKey(ctx, OPENROUTER_KEY_REF), cache: { get: k => core.db.getCache(k), put: (k, payload, now) => { core.db.putCache(k, payload, now) } }, referer: 'https://github.com/deestax/dsh-studio',
  }))
  registry.register(new ReplicateAdapter({
    apiToken: () => resolveKey(ctx, REPLICATE_KEY_REF),
    pinned: () => (core.db.getSetting('replicate.pinned') ?? '').split(/[\s,]+/).filter(Boolean),
  }))
  // Google direct: Nano Banana via generateContent plus Gemini Omni video. The configured legacy model (if any) is offered as an extra image model.
  registry.register(new GoogleDirectAdapter({
    apiKey: () => resolveKey(ctx, GOOGLE_KEY_REF),
    extraImageModels: () => [cfg().googleModel ?? DEFAULT_GOOGLE_MODEL].filter(m => m.length > 0),
  }))
  const compat = (provider: 'openai' | 'openai-compat' | 'xai'): (() => CompatEndpoint[]) => () => {
    const c = cfg()
    if (provider === 'openai') return [{ id: 'default', label: 'OpenAI', baseURL: c.openaiBaseURL ?? DEFAULT_OPENAI_BASE_URL, apiKey: () => resolveKey(ctx, 'OPENAI_API_KEY'), models: [c.openaiModel ?? DEFAULT_OPENAI_MODEL], provider, strict: c.strictImageDownloads === true }]
    if (provider === 'xai') return [{ id: 'default', label: 'xAI', baseURL: c.xaiBaseURL ?? DEFAULT_XAI_BASE_URL, apiKey: () => resolveKey(ctx, 'XAI_API_KEY'), models: [c.xaiModel ?? DEFAULT_XAI_MODEL], provider, strict: c.strictImageDownloads === true }]
    return resolveOpenAICompatChannels(c).map(ch => ({ id: ch.id, label: ch.label ?? ch.id, baseURL: ch.baseURL, apiKey: () => resolveKey(ctx, ch.keyRef), models: [...new Set([ch.model, ...(ch.models ?? [])].filter(m => m.length > 0))], provider, strict: c.strictImageDownloads === true }))
  }
  for (const provider of ['openai', 'openai-compat', 'xai'] as const) registry.register(new CompatAdapter(provider, compat(provider)))
  for (const provider of ['grok-sub', 'google-sub'] as const) {
    registry.register(new SubscriptionAdapter(provider, () => options.subscriptionManager, async () => {
      const status = await options.subscriptionManager.loginStatus(provider === 'grok-sub' ? 'grok' : 'antigravity')
      return status.state === 'logged-in'
    }))
  }
  registry.register(new ComfyUIAdapter({
    baseURL: () => cfg().comfyuiBaseURL ?? DEFAULT_COMFYUI_BASE_URL, timeoutMs: () => cfg().comfyuiTimeoutMs ?? DEFAULT_COMFYUI_TIMEOUT_MS,
    workflows: () => { const c = cfg(); const all = resolveComfyUIWorkflows(c); const active = activeComfyUIWorkflow(c); return active === undefined ? all : [active, ...all.filter(w => w.name !== active.name)] },
  }))

  // Agent media: every image/video a tool makes in ANY chat lands in the gallery (setting `agent.capture`, default on).
  // No database yet means nobody has switched it off: stay on without creating the file just to look.
  const captureEnabled = (): boolean => !existsSync(join(core.root, DB_FILE)) || core.db.getSetting('agent.capture') !== '0'
  const capture = new AgentCapture({
    core, enabled: captureEnabled, logger: ctx.logger, ...(options.home === undefined ? {} : { home: options.home }),
    readAttachment: async ref => (await ctx.attachments.readImage(ref)).data,
  })
  ctx.effect(() => () => { capture.dispose() }, 'dsh-studio: agent media capture')
  // The feed is the durable session event stream (the same one dsh-langfuse reads). A host without it simply captures nothing.
  if (typeof (ctx as { on?: unknown }).on === 'function') {
    ctx.on('session/event', (session: unknown, event: unknown) => { capture.onEvent(session as SessionLike, event as { type: string; time?: number; data?: unknown }) })
  }
  // `sessionQuery` is an optional service: Cordis throws when a service is read without an inject, so it is picked up only when it exists.
  let sessionQueryService: SessionQueryLike | undefined
  if (typeof (ctx as { inject?: unknown }).inject === 'function') {
    ctx.inject(['sessionQuery'], (queryCtx: Context) => {
      sessionQueryService = (queryCtx as unknown as { sessionQuery?: SessionQueryLike }).sessionQuery
      return () => { sessionQueryService = undefined }
    })
  }
  const sessionQuery = (): SessionQueryLike | undefined => sessionQueryService
  const history = (): SessionHistory | undefined => {
    const q = sessionQuery()
    if (q === undefined) return undefined
    return {
      list: async () => (await q.listSessions()).map(r => ({ id: String(r.header.id), ...(r.header.cwd === undefined ? {} : { cwd: r.header.cwd }) })),
      read: async id => { const log = await q.readSession(id); return { ...(log.session.cwd === undefined ? {} : { cwd: log.session.cwd }), events: log.events } },
    }
  }
  let backfilling: Promise<BackfillSummary> | undefined
  const agentApi: AgentMediaApi = {
    running: () => backfilling !== undefined,
    backfill: () => (backfilling ??= Promise.resolve().then(() => runBackfill(core, capture, { ...(options.home === undefined ? {} : { home: options.home }), history: history() })).finally(() => { backfilling = undefined })),
    sessionTitle: async id => { try { return (await sessionQuery()?.readTitle?.(id))?.title } catch { return undefined } },
  }
  // First start with this version: one automatic backfill, after the host has settled. The marker makes it run once; the gallery menu reruns it.
  const firstBackfill = setTimeout(() => {
    if (!captureEnabled() || readBackfillMarker(core) !== undefined || core.db.getSetting(BACKFILL_KEY) !== undefined) return
    // A timer callback must never throw: an uncaught exception here would take the whole host down.
    try { void agentApi.backfill().then(r => { ctx.logger.info(`dsh-studio: collected agent media from existing chats and folders (${String(r.imported)} new, ${String(r.alreadyThere)} already there, ${String(r.skipped)} skipped)`) }).catch((error: unknown) => { ctx.logger.warn(`dsh-studio: agent media backfill failed: ${error instanceof Error ? error.message.slice(0, 200) : 'unknown error'}`) }) } catch { /* never throw out of a timer */ }
  }, 20_000)
  firstBackfill.unref()
  ctx.effect(() => () => { clearTimeout(firstBackfill) }, 'dsh-studio: agent media first backfill')

  // Resume persisted jobs once the registry is populated. Runs after the first tick so settings are loaded.
  const resume = setTimeout(() => {
    // Nothing to resume unless a database already exists: do not create one just to find it empty.
    if (!existsSync(join(core.root, DB_FILE))) return
    void core.runner.resume().then(r => { if (r.resumed.length + r.lost.length + r.requeued.length > 0) ctx.logger.info(`dsh-studio: resumed ${String(r.resumed.length)} job(s), requeued ${String(r.requeued.length)}, marked ${String(r.lost.length)} lost-in-flight`) }).catch((error: unknown) => { ctx.logger.warn(`dsh-studio: job resume failed: ${String(error)}`) })
  }, 1500)
  resume.unref()
  // Daily purge of soft-deleted assets older than 30 days; unreferenced blobs are removed with them.
  const purge = setInterval(() => { void core.assets.purge(30 * 24 * 3600 * 1000).catch(() => undefined) }, 24 * 3600 * 1000)
  purge.unref()
  ctx.effect(() => () => { clearTimeout(resume); clearInterval(purge); void core.close() }, 'dsh-studio: v2 core')

  const hyperframes = new HyperframesManager(core, { logger: ctx.logger, cliPath: () => core.db.getSetting('hyperframes.cli'), allowNpx: () => core.db.getSetting('hyperframes.npx') === '1' })
  ctx.effect(() => () => { void hyperframes.dispose() }, 'dsh-studio: hyperframes previews')
  ctx.inject(['webServer'], (webCtx: Context) => {
    const handler = createV2Handler(core, hyperframes, { readAttachment: async ref => (await ctx.attachments.readImage(ref)).data, ...(options.home === undefined ? {} : { home: options.home }) }, agentApi)
    webCtx.effect(() => webCtx.webServer.register(options.withAdmission({ kind: 'prefix', path: ROUTE_BASE, handler: (req, res) => handler(req, res) })), 'dsh-studio: v2 routes')
  })

  registerV2Tools({
    ctx, core,
    sessionOf: exec => (exec as { agent?: { session?: { id?: string } } }).agent?.session?.id,
    attachImage: async (asset: AssetRecord) => {
      const bytes = await core.blobs.read(asset.sha256, asset.ext)
      if (!ctx.attachments.imageLimits.mediaTypes.includes(asset.mime as never)) return undefined
      return ctx.attachments.saveImage({ data: bytes, mediaType: asset.mime as never, name: asset.title ?? 'studio-image' })
    },
    defaultProvider: () => { const p = cfg().provider; return typeof p === 'string' && p.length > 0 ? p as ProviderId : undefined },
    resolveReferences: async (selectors, exec) => {
      const e = exec as { agent?: { session: { deriveMessages(): readonly never[]; header?: { cwd?: string } } }; signal: AbortSignal }
      const common = { ...(e.agent === undefined ? {} : { agent: e.agent as never }), maxBytes: ctx.attachments.imageLimits.maxImageBytes, signal: e.signal }
      return resolveReferenceImages({
        attachments: ctx.attachments, ...common,
        ...(selectors.source_attachment_id === undefined ? {} : { sourceAttachmentId: selectors.source_attachment_id }),
        ...(selectors.source_attachment_ids === undefined ? {} : { sourceAttachmentIds: selectors.source_attachment_ids }),
        ...(selectors.source_path === undefined ? {} : { sourcePath: selectors.source_path }),
        ...(selectors.source_paths === undefined ? {} : { sourcePaths: selectors.source_paths }),
      })
    },
    saveToWorkspace: async (ref, bytes, exec) => {
      const c = cfg()
      if (c.saveToWorkspace === false) return {}
      const root = (exec as { agent?: { session: { header: { cwd?: string } } } }).agent?.session.header.cwd
      if (root === undefined) return {}
      options.rememberWorkspace?.(root)
      const path = await saveImageToWorkspace({ workspaceRoot: root, folder: c.workspaceFolder, attachmentId: String(ref.attachmentId), mediaType: ref.mediaType as never, data: bytes, signal: (exec as { signal: AbortSignal }).signal })
      return { path }
    },
  })
  return core
}
