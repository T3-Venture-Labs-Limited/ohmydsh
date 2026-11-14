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
    const handler = createV2Handler(core, hyperframes, { readAttachment: async ref => (await ctx.attachments.readImage(ref)).data, ...(options.home === undefined ? {} : { home: options.home }) })
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
