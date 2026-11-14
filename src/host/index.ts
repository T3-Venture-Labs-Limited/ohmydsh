/**
 * Host half of dsh-pwa: makes the DSH web UI installable and adds a light phone page.
 *
 *   GET  /manifest.webmanifest   public; replaces the stock manifest (same icons) and adds share_target + shortcuts
 *   GET  /sw.js                  public; service worker that caches only public content-addressed files
 *   GET  /m, /m/*                signed-in; the light session / approvals page (vanilla JS, uses the same cookie)
 *   POST /share                  signed-in + same-origin; Android share-sheet target
 *   GET  /share?id=<id>          signed-in; the stored share for the /m page to turn into a session
 *
 * Routing (verified in dsh-host-webserver): the match order is exact route, then longest prefix, then the single
 * fallback seat that serves the SPA. A duplicate (kind, path) registration throws, so nothing here can silently
 * shadow another plugin; `/m` is a prefix route and the rest are exact routes.
 */
import { existsSync } from 'node:fs'
import { mkdir, readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { readConfig, type PwaConfig } from './config.ts'
import { buildManifest } from './manifest.ts'
import { killSwitchSource, serviceWorkerSource } from './sw-source.ts'
import { PAGE_ASSETS, loadPageFile, renderMobileIndex, stylesheetHrefs, type PageFile } from './pages.ts'
import { ShareError, isShareId, pruneShares, readShare, receiveShare } from './share.ts'

export const name = 'dsh-pwa'
export const inject = ['webServer', 'connection']

const VERSION = '0.1.0'
/** `public/` sits next to `lib/` in the package; from `src/host/` (tests) it is two levels up. */
const PUBLIC_DIR = ['../public/', '../../public/'].map((rel) => new URL(rel, import.meta.url)).find((url) => existsSync(new URL('m/app.js', url))) ?? new URL('../public/', import.meta.url)
const SHARE_TTL_MS = 7 * 24 * 3600 * 1000

interface Route { kind: 'exact' | 'prefix'; path: string; handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void> }
interface Ctx {
  effect(fn: () => unknown, label?: string): void
  on(event: string, fn: (...args: any[]) => unknown, opts?: unknown): () => void // eslint-disable-line
  webServer: {
    register(route: Route): () => void
    readResource?(request: Request, peer: unknown): Promise<Response>
  }
  connection: {
    requestRejection(request: { headers: IncomingMessage['headers'] }): 401 | 403 | undefined
    browserPeer: unknown
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

export function dataDir(): string {
  return join(process.env['DSH_HOME'] ?? join(homedir(), '.dsh'), 'plugin-data', 'dsh-pwa')
}

export function apply(ctx: Ctx, rawConfig?: unknown): void {
  const config: PwaConfig = readConfig(rawConfig)
  const log = ctx.logger('dsh-pwa')
  const sharesDir = join(dataDir(), 'shares')

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

  // ── Registration helper: every route is a disposable effect owned by this plugin ──
  const route = (r: Route): void => {
    ctx.effect(() => ctx.webServer.register(r), `dsh-pwa: ${r.kind} ${r.path}`)
  }

  // The service worker revision changes with the plugin version and the SW-relevant config.
  const swSource = config.serviceWorker ? serviceWorkerSource(`${VERSION}`) : killSwitchSource()

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

  // ── /m: the light phone page ──
  const pageCache = new Map<string, PageFile>()
  const pageFile = async (file: string): Promise<PageFile> => {
    const cached = pageCache.get(file)
    if (cached !== undefined) return cached
    const loaded = await loadPageFile(PUBLIC_DIR, file)
    pageCache.set(file, loaded)
    return loaded
  }
  /** The host's own stylesheets (real theme tokens), read once from the in-process index render. */
  let styles: string[] | undefined
  const hostStyles = async (): Promise<string[]> => {
    if (styles !== undefined) return styles
    try {
      const response = await ctx.webServer.readResource?.(new Request('http://dsh.internal/'), ctx.connection.browserPeer)
      styles = response === undefined || !response.ok ? [] : stylesheetHrefs(await response.text())
    } catch (error) {
      log.warn('could not read the host index for stylesheets', error)
      styles = []
    }
    return styles
  }

  route({
    kind: 'prefix',
    path: '/m',
    handler: async (req, res) => {
      if (rejected(req, res)) return
      if (!methods(req, res, ['GET', 'HEAD'])) return
      const pathname = new URL(req.url ?? '/', 'http://x').pathname
      try {
        if (pathname === '/m' || pathname === '/m/') {
          const [app, css, events] = await Promise.all([pageFile('app.js'), pageFile('app.css'), pageFile('events.js')])
          const html = renderMobileIndex({ stylesheets: await hostStyles(), appRev: app.rev, cssRev: css.rev, eventsRev: events.rev, name: config.name })
          send(res, 200, req.method === 'HEAD' ? '' : html, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
          return
        }
        const file = pathname.slice('/m/'.length)
        if (!(PAGE_ASSETS as readonly string[]).includes(file)) { send(res, 404, ''); return }
        const asset = await pageFile(file)
        const versioned = new URL(req.url ?? '/', 'http://x').searchParams.has('v')
        send(res, 200, req.method === 'HEAD' ? '' : asset.body, {
          'content-type': asset.type,
          'cache-control': versioned ? 'public, max-age=31536000, immutable' : 'no-cache',
        })
      } catch (error) {
        log.warn('/m failed', error)
        send(res, 500, 'The phone page is unavailable.', { 'content-type': 'text/plain; charset=utf-8' })
      }
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
        sendJson(res, 200, { ok: true, share: record, mode: config.share.mode })
        return
      }
      if (req.method !== 'POST') { send(res, 405, '', { allow: 'GET, POST' }); return }
      // A share-sheet POST is a top-level navigation: SameSite=Strict cookies are not sent on cross-site navigations,
      // but the share sheet is browser-initiated (no initiating site), so the cookie IS sent. Anything else fails
      // the 401 gate above; the Origin check blocks a cross-site form from posting here.
      if (!sameOrigin(req)) { send(res, 403, 'cross-site request rejected', { 'content-type': 'text/plain; charset=utf-8' }); return }
      try {
        await mkdir(sharesDir, { recursive: true, mode: 0o700 })
        const filesDir = config.share.cwd !== '' ? join(config.share.cwd, '.dsh-shares') : undefined
        const record = await receiveShare(req, { dir: sharesDir, cwd: config.share.cwd, maxBytes: config.share.maxMiB * 1024 * 1024, ...(filesDir === undefined ? {} : { filesDir }) })
        // 303 turns the POST into a GET of /m, so a reload does not resubmit the share.
        send(res, 303, '', { location: `/m?share=${record.id}`, 'cache-control': 'no-store' })
      } catch (error) {
        const status = error instanceof ShareError ? error.status : 500
        if (status === 500) log.warn('share failed', error)
        send(res, status, error instanceof ShareError ? error.message : 'share failed', { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
      }
    },
  })

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
