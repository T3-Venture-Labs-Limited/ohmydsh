/** Dsh Studio: multi-provider image and video studio Bundle for DeepSeek Harness. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-connection'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import type { SettingsForms } from '@deepseek-ai/dsh-settings'
import { Config, migrateOpenAICompatConfig } from './config.js'
import { resolveApiKey } from './credentials.js'
import { wireV2 } from './v2/wire.js'
import { registerStudioRemote } from './v2/push.js'
import { IMAGE_ROUTE, serveImage } from './image-route.js'
import { durableAttachmentsRoot, pruneRequestImageCache, resolveRequestImageCacheDir } from './request-cache.js'
import { registerSubscriptionRoutes, SubscriptionManager } from './subscription.js'
import { IMAGE_GENERATION_NAMESPACE, TEST_CONNECTION_ROUTE, resolveOpenAICompatChannel } from './shared.js'
import { vaultConfigOf } from './vault-store.js'
import { serveTestConnection } from './test-route.js'
import { describeSettingsHealth, serveSettingsHealth } from './settings-health.js'
import { SETTINGS_HEALTH_ROUTE, type SettingsHealth } from './shared.js'
import { imageToolContext } from './image-tool-context.js'
import { resolveWebAdmission, withWebAdmission, type WebAdmission } from './web-route.js'

export { Config } from './config.js'
export { IMAGE_ROUTE, imageAttachmentFromMeta } from './image-route.js'
export { TEST_CONNECTION_ROUTE } from './shared.js'

export const name = '@t3labs/ohmydsh-studio'
export const inject = ['tools', 'attachments', 'credentials']

export function apply(ctx: Context, config: Config = {}): void {
  // DSH 0.1.7 resolves every `.volatile()` schema field into a stable box
  // whose `.get()` returns the current snapshot, so a settings edit lands
  // without restarting this fiber. Unbox on every read; older hosts hand
  // over plain values, which the same walk returns untouched.
  const plainConfig = (source: Config): Config => {
    const out: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(source)) {
      out[key] = value !== null && typeof value === 'object' && typeof (value as { get?: unknown }).get === 'function'
        ? (value as { get(): unknown }).get()
        : value
    }
    return out as Config
  }
  // Migration on every read: relay configs saved under the old single OpenAI
  // slot keep moving to the dedicated compat row until the persisted copy is
  // rewritten, so both rows coexist after any upgrade.
  let current: () => Config = () => migrateOpenAICompatConfig(plainConfig(config))
  const knownWorkspaceRoots = new Set<string>()
  // Subscription image accounts: login flows, blob storage, refresh, and the
  // vendor wire calls. One instance per application; tokens stay host-side.
  const subscriptionManager = new SubscriptionManager(ctx)
  // Prompt contexts are synchronous, while credential and login reads are not.
  let configuredImageProviders: readonly string[] | undefined
  let imageContextRevision = 0
  let v2: ReturnType<typeof wireV2> | undefined
  const refreshImageToolContext = async () => {
    const revision = ++imageContextRevision
    try {
      const providers = v2 === undefined ? undefined : [...await v2.registry.configuredProviders()]
      if (revision === imageContextRevision && providers !== undefined) configuredImageProviders = providers
    } catch { /* Keep the last credential-free snapshot when status reads fail. */ }
  }

  // Raw-image vault: re-read on every call so settings changes apply without a restart.
  const vaultConfig = () => vaultConfigOf(current())

  const settingsHealth = installImageSettings(ctx, current(), {
    setSource: source => { current = () => migrateOpenAICompatConfig(plainConfig(source())) },
    onChange: () => { void refreshImageToolContext() },
  })
  // Request-image variants are generated on demand and cached forever by the
  // attachment backend; keep that cache bounded without touching fresh files.
  ctx.effect(() => {
    const run = (): void => {
      const config = current()
      if (config.requestCachePrune === false) return
      const ttlDays = config.requestCacheTtlDays ?? 14
      const maxBytes = config.requestCacheMaxBytes ?? 256 * 1024 * 1024
      const configured = config.requestCacheDir ?? ''
      const dir = configured.length > 0 ? configured : resolveRequestImageCacheDir()
      void pruneRequestImageCache({
        dir,
        ttlMs: ttlDays * 24 * 60 * 60 * 1000,
        maxBytes,
        // Never prune the durable attachment objects or raw vault originals,
        // even when requestCacheDir is a Windows case variant or a junction.
        protectedRoots: [durableAttachmentsRoot(), vaultConfig().dir],
      })
        .then(stats => {
          if (stats.removed > 0) {
            ctx.logger.info('dsh-studio: pruned ' + String(stats.removed) + ' request-image variants (' + String(stats.freedBytes) + ' bytes)')
          }
        })
        .catch((error: unknown) => {
          ctx.logger.warn('dsh-studio: request-image cache prune failed: ' + (error instanceof Error ? error.message : String(error)))
        })
    }
    const startup = setTimeout(run, 30_000)
    const daily = setInterval(run, 24 * 60 * 60 * 1000)
    startup.unref()
    daily.unref()
    return () => {
      clearTimeout(startup)
      clearInterval(daily)
    }
  }, 'dsh-studio: request image cache upkeep')
  let webAdmission: WebAdmission | undefined
  const getWebAdmission = () => resolveWebAdmission(webAdmission, current().requireHostAdmission === true)
  ctx.inject(['connection'], (connectionCtx: Context) => {
    const check: WebAdmission = request => connectionCtx.connection.requestRejection(request)
    webAdmission = check
    return () => { if (webAdmission === check) webAdmission = undefined }
  })
  // v2: provider registry, content-addressed asset store, persistent job runner and the studio_make/job/gallery/models tools.
  v2 = wireV2(ctx, {
    config: () => current(), subscriptionManager, rememberWorkspace: root => { knownWorkspaceRoots.add(root) },
    admission: () => getWebAdmission() as never,
    withAdmission: route => withWebAdmission(route, getWebAdmission),
  })
  // Job/asset push channel: a Typert stream on DSH's multiplexed Remote WebSocket (no HTTP stream, no polling).
  const studioCore = v2
  ctx.effect(() => registerStudioRemote(ctx as never, studioCore), 'dsh-studio: remote stream')
  void refreshImageToolContext()

  // Every HTTP surface needs webServer, which only the web-app bundle (web,
  // desktop) provides; the headless, acp and sdk profiles have none. Mount the
  // routes when it is present so the tools below still activate without it.
  ctx.inject(['webServer'], (webCtx: Context) => {
    const register = (route: WebRoute) => webCtx.webServer.register(withWebAdmission(route, getWebAdmission))
    registerSubscriptionRoutes(webCtx, subscriptionManager, getWebAdmission)
    webCtx.effect(() => register({
      kind: 'exact', path: SETTINGS_HEALTH_ROUTE,
      handler: (req, res) => serveSettingsHealth(req, res, settingsHealth()),
    }), 'dsh-studio: settings health')
    webCtx.effect(() => register({
      kind: 'exact', path: IMAGE_ROUTE,
      handler: (req, res) => serveImage(req, res, { readImage: ref => ctx.attachments.readImage(ref) }),
    }), 'dsh-studio: image route')
    webCtx.effect(() => register({
      kind: 'exact', path: TEST_CONNECTION_ROUTE,
      handler: (req, res) => serveTestConnection(req, res, {
        resolveKey: (provider, channel) => resolveApiKey(ctx, provider, provider === 'openai-compat' ? resolveOpenAICompatChannel(current(), channel).keyRef : undefined),
        config: () => current(),
        subscriptionManager,
      }),
    }), 'dsh-studio: test connection route')
  })
  // A few lines of image-tool context per model request. The service is an
  // optional dependency: hosts without dsh-system-prompt boot unchanged.
  ctx.inject(['systemPrompt'], (promptCtx: Context) => {
    void refreshImageToolContext()
    ctx.inject(['credentials'], credentialCtx => {
      credentialCtx.on('credentials/reference-updated', () => { void refreshImageToolContext() })
      credentialCtx.on('credentials/record-updated', () => { void refreshImageToolContext() })
    })
    promptCtx.effect(() => promptCtx.systemPrompt.context({
      name: 'dsh-studio:image-defaults',
      order: 59,
      text: () => imageToolContext(current(), configuredImageProviders),
    }), 'dsh-studio: image tool context')
  })
}

/** Settings hooks shape shared by both dsh-settings API generations. */
interface SettingsHooks {
  setSource: (source: () => Config) => void
  onChange: () => void
}

/** The `settings` Context service as typed by dsh-settings 0.1.2–0.1.6. */
interface SettingsSectionInstaller {
  installSection(ctx: Context, namespace: unknown, schema: unknown, entry: unknown, hooks: SettingsHooks): void
}

/**
 * Wire the settings namespace across both dsh-settings API generations.
 * The probe reads the HOST's `settings` service, never the bundled
 * dsh-settings module: the build inlines that module, so its exports always
 * look like the compile-time generation while only the service handed to this
 * fiber reflects the running host. dsh-settings 0.1.2–0.1.6 put `installSection`
 * on the service, so the namespace registers through it; DSH 0.1.7 replaced it
 * with schema-derived forms served by the loader itself (keyed by entry id),
 * so its service carries no installer and a host without any settings service
 * simply never runs the callback. A modern host with an unmarked schema is
 * incompatible and must be diagnosed, while old hosts keep their installer.
 */
function installImageSettings(ctx: Context, config: Config, hooks: SettingsHooks): () => SettingsHealth {
  let service: unknown
  ctx.inject(['settings'], settingsCtx => {
    const settings = settingsCtx.settings as SettingsForms & Partial<SettingsSectionInstaller>
    service = settings
    const health = describeSettingsHealth(settings, Config)
    if (health.settings === 'live' && !health.liveSchema) {
      ctx.logger.warn('dsh-studio: the loaded schema lacks volatile fields required by this DSH settings service. Install @deepseek-ai/schemastery >=3.18.4 <4 in the plugin profile and check which copy the plugin resolves; settings cannot be saved with this schema.')
    }
    if (typeof settings.installSection === 'function') {
      settings.installSection(ctx, IMAGE_GENERATION_NAMESPACE, Config, config, hooks)
    }
    return () => { service = undefined }
  })
  return () => describeSettingsHealth(service, Config)
}
