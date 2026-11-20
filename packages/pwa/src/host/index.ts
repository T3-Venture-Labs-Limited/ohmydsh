/**
 * Host half of dsh-pwa: installs the normal DSH web UI as an app and sends Web Push notifications to phones.
 *
 *   GET  /manifest.webmanifest   public; replaces the stock manifest (same icons; start_url "/", standalone, share_target)
 *   GET  /app, /app.js           public, secret-free launch page: signs in via a same-origin fetch (the Strict cookie is not
 *                                sent on the cross-site launcher navigation), then goes to / or shows a paste-link form
 *   GET  /sw.js                  public; service worker: public-file cache + push + notification click + share intake
 *   POST /share                  signed-in + same-origin; share target; 303 to /?share=<id>, or JSON {id} when asked
 *   GET  /share?id=<id>          signed-in; the stored share, read by the normal UI to pre-fill a draft
 *   GET  /push/key               signed-in; the VAPID public key
 *   POST /push/subscribe         signed-in + same-origin; store this device's PushSubscription
 *   POST /push/unsubscribe       signed-in + same-origin; forget it
 *   POST /push/test              signed-in + same-origin; push one test notification to the calling device
 *   POST /pair/code, GET /pair/devices, POST /pair/remove   signed-in; phone pairing (see pair-routes.ts)
 *   POST /pair/claim, GET /pair/session, GET /app/pair      public + rate-limited; device token claim / session exchange
 *
 * Routing (verified in dsh-host-webserver): the match order is exact route, then longest prefix, then the single
 * fallback seat that serves the SPA, and a duplicate (kind, path) registration throws, so these exact routes cannot
 * silently shadow another plugin.
 */
import { mkdir, readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { readConfig, type PwaConfig } from './config.ts'
import { buildManifest } from './manifest.ts'
import { killSwitchSource, serviceWorkerSource } from './sw-source.ts'
import { ShareError, isShareId, pruneShares, readShare, receiveShare } from './share.ts'
import { loadVapid, type VapidKeys } from './vapid.ts'
import { SubscriptionError, SubscriptionStore, parseSubscription, redactEndpoint } from './subscriptions.ts'
import { createPusher, type Pusher } from './push.ts'
import { createNotifier } from './notifier.ts'
import { APP_CSP, appPageHtml, appScriptSource } from './app-page.ts'
import { CodeBook, DeviceStore, FailureLimiter } from './pairing.ts'
import { registerPairing } from './pair-routes.ts'
import { PAIR_CSP, pairPageHtml, pairScriptSource } from './pair-page.ts'
import { chooseOrigin } from './origin.ts'
import { installAdmitGate, trackDeviceSockets, type UpgradeServer } from './revocation.ts'

export const name = '@t3labs/ohmydsh-pwa'
export const inject = ['webServer', 'connection']

const VERSION = '0.3.1'
const SHARE_TTL_MS = 7 * 24 * 3600 * 1000
const MAX_JSON_BYTES = 8 * 1024

interface Route { kind: 'exact' | 'prefix'; path: string; handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void> }
interface Ctx {
  effect(fn: () => unknown, label?: string): void
  on(event: string, fn: (...args: any[]) => unknown, opts?: unknown): () => void // eslint-disable-line
  webServer: { register(route: Route): () => void; host?: string; port?: number; protocol?: 'http:' | 'https:'; server?: UpgradeServer }
  connection: {
    requestRejection(request: { headers: IncomingMessage['headers'] }): 401 | 403 | undefined
    admit?: (request: { headers: IncomingMessage['headers'] | Headers }) => unknown
    authorizeIndex?(request: { method?: string; url?: string; headers: IncomingMessage['headers'] }, response: { writeHead(status: number, headers?: Record<string, string>): unknown; end(body?: string): unknown }): boolean
    authenticatedUrl?(baseUrl: string): string
  }
  logger(name: string): { warn(...a: unknown[]): void; debug(...a: unknown[]): void }
}

function send(res: ServerResponse, status: number, body: string | Buffer, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'x-content-type-options': 'nosniff', ...headers })
  res.end(body)
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  send(res, status, JSON.stringify(value), { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
}

/** Same-origin check for mutations: browsers send Origin on POST; a missing Origin is accepted only with Sec-Fetch-Site same-origin/none. */
export function sameOrigin(req: IncomingMessage): boolean {
  const origin = req.headers['origin']
  const host = req.headers['host']
  if (typeof origin === 'string' && origin !== '' && origin !== 'null') {
    try { return new URL(origin).host === host } catch { return false }
  }
  const site = req.headers['sec-fetch-site']
  return site === undefined || site === 'same-origin' || site === 'none'
}

function portOf(host: unknown): number {
  try { return Number(new URL(`http://${String(host)}`).port) || 3080 } catch { return 3080 }
}

export function dataDir(): string {
  return join(process.env['DSH_HOME'] ?? join(homedir(), '.dsh'), 'plugin-data', 'dsh-pwa')
}

/** A short human label for a device, from the User-Agent (best effort; the client may send its own). */
export function deviceLabel(userAgent: unknown): string {
  const ua = typeof userAgent === 'string' ? userAgent : ''
  const os = /Android/i.test(ua) ? 'Android' : /iPhone|iPad/i.test(ua) ? 'iOS' : /Windows/i.test(ua) ? 'Windows' : /Mac OS X/i.test(ua) ? 'macOS' : /Linux/i.test(ua) ? 'Linux' : 'Device'
  const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'browser'
  return `${os} ${browser}`
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const type = String(req.headers['content-type'] ?? '')
  if (!/^application\/json\b/i.test(type)) throw new SubscriptionError('content-type must be application/json')
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).byteLength
    if (size > MAX_JSON_BYTES) throw new SubscriptionError('body too large')
    chunks.push(chunk as Buffer)
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw new SubscriptionError('invalid JSON') }
}

export function apply(ctx: Ctx, rawConfig?: unknown): void {
  const config: PwaConfig = readConfig(rawConfig)
  const log = ctx.logger('dsh-pwa')
  const dir = dataDir()
  const sharesDir = join(dir, 'shares')
  const store = new SubscriptionStore(join(dir, 'subscriptions.json'))
  const devices = new DeviceStore(join(dir, 'devices.json'))
  void devices.warm().catch((error: unknown) => { log.warn('could not read the paired devices file', (error as Error).message) })

  // The VAPID pair is created on first use and kept for good (a new pair would orphan every subscription).
  let vapidPromise: Promise<VapidKeys> | undefined
  const vapid = (): Promise<VapidKeys> => (vapidPromise ??= loadVapid(dir).catch((error: unknown) => { vapidPromise = undefined; throw error }))
  let pusherPromise: Promise<Pusher> | undefined
  const pusher = (): Promise<Pusher> => (pusherPromise ??= vapid().then((keys) => createPusher({ vapid: keys, subject: config.push.subject, store, log })).catch((error: unknown) => { pusherPromise = undefined; throw error }))

  // Gate for every signed-in route: Host/Origin fence plus authentication, failing closed.
  const rejected = (req: IncomingMessage, res: ServerResponse): boolean => {
    const status = ctx.connection.requestRejection({ headers: req.headers })
    if (status === undefined) return false
    send(res, status, status === 401 ? 'Sign in to DSH first: open the DSH link with its token once on this device.' : 'Forbidden', { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
    return true
  }

  const methods = (req: IncomingMessage, res: ServerResponse, allowed: readonly string[]): boolean => {
    if (req.method !== undefined && allowed.includes(req.method)) return true
    send(res, 405, '', { allow: allowed.join(', ') })
    return false
  }

  const route = (r: Route): void => {
    ctx.effect(() => ctx.webServer.register(r), `dsh-pwa: ${r.kind} ${r.path}`)
  }

  const swSource = config.serviceWorker ? serviceWorkerSource(VERSION, { maxShareBytes: config.share.maxMiB * 1024 * 1024 }) : killSwitchSource()

  route({
    kind: 'exact',
    path: '/manifest.webmanifest',
    handler: (req, res) => {
      if (!methods(req, res, ['GET', 'HEAD'])) return
      // Public like the stock manifest (browsers fetch it without credentials) and free of secrets.
      send(res, 200, req.method === 'HEAD' ? '' : JSON.stringify(buildManifest(config)), {
        'content-type': 'application/manifest+json; charset=utf-8',
        'cache-control': 'no-cache',
      })
    },
  })

  // The launch page. Public on purpose: it must load before the browser has proven who it is, and contains no secret.
  const appAsset = (path: string, type: string, body: () => string, extra: Record<string, string> = {}): void => route({
    kind: 'exact',
    path,
    handler: (req, res) => {
      if (!methods(req, res, ['GET', 'HEAD'])) return
      send(res, 200, req.method === 'HEAD' ? '' : body(), { 'content-type': type, 'cache-control': 'no-store', ...extra })
    },
  })
  const appHtml = appPageHtml()
  const appJs = appScriptSource()
  appAsset('/app', 'text/html; charset=utf-8', () => appHtml, { 'content-security-policy': APP_CSP, 'referrer-policy': 'no-referrer' })
  appAsset('/app.js', 'text/javascript; charset=utf-8', () => appJs)

  route({
    kind: 'exact',
    path: '/sw.js',
    handler: (req, res) => {
      if (!methods(req, res, ['GET', 'HEAD'])) return
      send(res, 200, req.method === 'HEAD' ? '' : swSource, {
        'content-type': 'text/javascript; charset=utf-8',
        // The browser must always revalidate the worker script itself.
        'cache-control': 'no-cache',
        'service-worker-allowed': '/',
      })
    },
  })

  // ── /share: Android share-sheet target ──
  route({
    kind: 'exact',
    path: '/share',
    handler: async (req, res) => {
      if (rejected(req, res)) return
      if (!config.share.enabled) { send(res, 404, ''); return }
      if (req.method === 'GET') {
        const id = new URL(req.url ?? '/', 'http://x').searchParams.get('id') ?? ''
        const record = isShareId(id) ? await readShare(sharesDir, id) : undefined
        if (record === undefined) { sendJson(res, 404, { ok: false, error: 'unknown share' }); return }
        sendJson(res, 200, { ok: true, share: record })
        return
      }
      if (req.method !== 'POST') { send(res, 405, '', { allow: 'GET, POST' }); return }
      // A raw share-sheet POST is cross-site and carries no Strict cookie (the service worker takes it first and /app
      // re-posts it from a same-origin fetch). The Origin check still blocks a cross-site form from posting here.
      if (!sameOrigin(req)) { send(res, 403, 'cross-site request rejected', { 'content-type': 'text/plain; charset=utf-8' }); return }
      try {
        await mkdir(sharesDir, { recursive: true, mode: 0o700 })
        const filesDir = config.share.cwd !== '' ? join(config.share.cwd, '.dsh-shares') : undefined
        const record = await receiveShare(req, { dir: sharesDir, cwd: config.share.cwd, maxBytes: config.share.maxMiB * 1024 * 1024, ...(filesDir === undefined ? {} : { filesDir }) })
        // A same-origin fetch from /app asks for JSON; the 303 stays for plain form posts.
        if (/\bapplication\/json\b/i.test(String(req.headers['accept'] ?? ''))) { sendJson(res, 200, { ok: true, id: record.id }); return }
        // 303 turns the POST into a GET of the normal UI, so a reload does not resubmit the share.
        send(res, 303, '', { location: `/?share=${record.id}`, 'cache-control': 'no-store' })
      } catch (error) {
        const status = error instanceof ShareError ? error.status : 500
        if (status === 500) log.warn('share failed', error)
        send(res, status, error instanceof ShareError ? error.message : 'share failed', { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
      }
    },
  })

  // ── Phone pairing ──
  if (config.pairing.enabled) {
    const conn = ctx.connection
    registerPairing({
      store: devices,
      codes: new CodeBook(),
      claimLimiter: new FailureLimiter(5, 30, 10 * 60 * 1000),
      sessionLimiter: new FailureLimiter(20, 100, 10 * 60 * 1000),
      route,
      rejected,
      untrusted: (req) => ctx.connection.requestRejection({ headers: req.headers }) === 403,
      sameOrigin,
      mint: async (req) => {
        if (conn.authorizeIndex === undefined || conn.authenticatedUrl === undefined) throw new Error('this DSH version cannot sign a device in')
        // The launch token is read and spent inside this process: it is never written to a response, a log or the page.
        const token = new URL(conn.authenticatedUrl('http://dsh.invalid/')).searchParams.get('token') ?? ''
        const out: { status: number; cookies: string[] } = { status: 0, cookies: [] }
        conn.authorizeIndex(
          { method: 'GET', url: `/?token=${encodeURIComponent(token)}`, headers: { host: req.headers['host'] } },
          { writeHead: (status, headers) => { out.status = status; const c = headers?.['set-cookie']; if (typeof c === 'string') out.cookies.push(c) }, end: () => {} },
        )
        if (out.status !== 303 || out.cookies.length === 0) throw new Error('DSH did not sign this address in. Open the pairing link at an address DSH trusts (see --trusted-host).')
        return out.cookies
      },
      chooseOrigin: (req) => chooseOrigin({
        bind: { host: ctx.webServer.host ?? '127.0.0.1', port: ctx.webServer.port ?? portOf(req.headers['host']), protocol: ctx.webServer.protocol ?? 'http:' },
        requestHost: typeof req.headers['host'] === 'string' ? req.headers['host'] : undefined,
      }),
      log,
      pageHtml: pairPageHtml(),
      pageScript: pairScriptSource(),
      pageCsp: PAIR_CSP,
    })
    // Core's sign-in cookie is stateless, so "Remove" is enforced here: every request whose cookie was minted for a removed
    // device is refused by core's own admission (all plugin routes, /api, the WebSocket upgrade) and its open sockets close.
    ctx.effect(() => installAdmitGate(ctx.connection as never, devices), 'dsh-pwa: refuse removed devices')
    ctx.effect(() => {
      const tracker = trackDeviceSockets(ctx.webServer.server, devices)
      devices.onRemoved = (id) => { tracker.closeDevice(id) }
      return () => { devices.onRemoved = undefined; tracker.dispose() }
    }, 'dsh-pwa: close sockets of removed devices')
  }

  // ── Web Push ──
  if (config.push.enabled) {
    /** Common prologue of the three POST routes: method, sign-in, same-origin, JSON body. Returns the body or undefined after answering. */
    const mutation = async (req: IncomingMessage, res: ServerResponse): Promise<Record<string, unknown> | undefined> => {
      if (!methods(req, res, ['POST'])) return undefined
      if (rejected(req, res)) return undefined
      if (!sameOrigin(req) || req.headers['sec-fetch-site'] === 'cross-site') { send(res, 403, 'cross-site request rejected', { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }); return undefined }
      try {
        const body = await readJson(req)
        return body !== null && typeof body === 'object' ? body as Record<string, unknown> : {}
      } catch (error) {
        sendJson(res, 400, { ok: false, error: error instanceof SubscriptionError ? error.message : 'bad request' })
        return undefined
      }
    }
    const unavailable = (res: ServerResponse, error: unknown): void => {
      log.warn('push is unavailable', (error as Error).message)
      sendJson(res, 503, { ok: false, error: 'push is unavailable on this host' })
    }

    route({
      kind: 'exact',
      path: '/push/key',
      handler: async (req, res) => {
        if (!methods(req, res, ['GET'])) return
        if (rejected(req, res)) return
        try { sendJson(res, 200, { ok: true, publicKey: (await vapid()).publicKey }) } catch (error) { unavailable(res, error) }
      },
    })

    route({
      kind: 'exact',
      path: '/push/subscribe',
      handler: async (req, res) => {
        const body = await mutation(req, res)
        if (body === undefined) return
        try {
          const subscription = parseSubscription(body['subscription'], { allowInsecure: config.push.allowInsecureEndpoints })
          const label = typeof body['label'] === 'string' && body['label'].trim() !== '' ? body['label'].trim().slice(0, 60) : deviceLabel(req.headers['user-agent'])
          await store.upsert(subscription, label)
          log.debug('push subscription stored', redactEndpoint(subscription.endpoint))
          sendJson(res, 200, { ok: true, label })
        } catch (error) {
          if (error instanceof SubscriptionError) sendJson(res, 400, { ok: false, error: error.message })
          else { log.warn('subscribe failed', (error as Error).message); sendJson(res, 500, { ok: false, error: 'could not store the subscription' }) }
        }
      },
    })

    route({
      kind: 'exact',
      path: '/push/unsubscribe',
      handler: async (req, res) => {
        const body = await mutation(req, res)
        if (body === undefined) return
        const endpoint = body['endpoint']
        if (typeof endpoint !== 'string' || endpoint === '') { sendJson(res, 400, { ok: false, error: 'endpoint required' }); return }
        try { sendJson(res, 200, { ok: true, removed: await store.remove(endpoint) }) } catch (error) { log.warn('unsubscribe failed', (error as Error).message); sendJson(res, 500, { ok: false, error: 'could not remove the subscription' }) }
      },
    })

    route({
      kind: 'exact',
      path: '/push/test',
      handler: async (req, res) => {
        const body = await mutation(req, res)
        if (body === undefined) return
        const endpoint = body['endpoint']
        const subscription = typeof endpoint === 'string' ? await store.get(endpoint) : undefined
        if (subscription === undefined) { sendJson(res, 404, { ok: false, error: 'this device is not subscribed' }); return }
        try {
          const result = await (await pusher()).sendTo(subscription, { v: 1, kind: 'test', title: 'DSH notifications work', body: 'This is a test notification from your DSH host.', sessionId: '' })
          sendJson(res, result === 'sent' ? 200 : 502, { ok: result === 'sent', result })
        } catch (error) { unavailable(res, error) }
      },
    })

    // Session feed -> notifications. Subscribed devices only: with no subscription nothing is encrypted or sent.
    const notifier = createNotifier({
      notify: async (payload) => {
        if ((await store.list()).length === 0) return
        await (await pusher()).broadcast(payload)
      },
    })
    ctx.effect(() => {
      const offEvent = ctx.on('session/event', (session: never, event: never) => {
        try { notifier.handle(session, event) } catch (error) { log.warn('push notifier failed', (error as Error).message) }
      })
      const offDisposed = ctx.on('session/disposed', (session: never) => { try { notifier.forget(session) } catch { /* ignore */ } })
      return () => { offEvent(); offDisposed(); notifier.dispose() }
    }, 'dsh-pwa: session events to push')
  }

  // ── Register the service worker from the host index (structured injection; no client plugin needed) ──
  if (config.serviceWorker) {
    ctx.on('webserver/index-inject', (table: { push(row: unknown): void }) => {
      table.push({
        kind: 'script',
        placement: 'body',
        text: 'if("serviceWorker"in navigator&&window.isSecureContext)addEventListener("load",function(){navigator.serviceWorker.register("/sw.js",{scope:"/"}).catch(function(){})})',
      })
    })
  }

  // ── Housekeeping: drop shares older than a week at start ──
  ctx.effect(() => {
    const timer = setTimeout(async () => {
      try {
        const names = await readdir(sharesDir)
        await pruneShares(sharesDir, names.filter((n) => n.endsWith('.json')).map((n) => n.slice(0, -5)), SHARE_TTL_MS)
        await stat(sharesDir)
      } catch { /* nothing shared yet */ }
    }, 10_000)
    timer.unref?.()
    return () => clearTimeout(timer)
  }, 'dsh-pwa: prune old shares')
}
