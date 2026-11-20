// HTTP surface of phone pairing. Wired by index.ts; every dependency is injected so the rules are unit-tested.
//
//   POST /pair/code      signed in + same-origin   issue a one-time code (10 min, single use) and the best address for a phone
//   GET  /pair/devices   signed in                 paired devices (never tokens)
//   POST /pair/remove    signed in + same-origin   revoke a device immediately
//   POST /pair/claim     PUBLIC, rate-limited      {code, deviceName[, mode:'cookie']} -> device token (or a browser session)
//   GET  /pair/session   PUBLIC, Bearer device     303 / with the normal DSH sign-in cookie (+ a device marker cookie)
//   GET  /app/pair       PUBLIC                    landing page of the plain https link: opens the app, or signs this browser in
import type { IncomingMessage, ServerResponse } from 'node:http'
import { CodeBook, DeviceStore, FailureLimiter, PairingError, bearerToken, cleanDeviceName } from './pairing.ts'
import { pairLinks, type OriginChoice } from './origin.ts'

export interface PairDeps {
  store: DeviceStore
  codes: CodeBook
  claimLimiter: FailureLimiter
  sessionLimiter: FailureLimiter
  route(r: { kind: 'exact'; path: string; handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void> }): void
  /** Core's Host/Origin fence + authentication for signed-in routes; true when it answered. */
  rejected(req: IncomingMessage, res: ServerResponse): boolean
  /** Core's Host/Origin fence WITHOUT credentials: 403 means the Host/Origin is not trusted; anything else may proceed. */
  untrusted(req: IncomingMessage): boolean
  sameOrigin(req: IncomingMessage): boolean
  /** Mint core's sign-in cookie(s) for this request's Host without the launch token ever leaving the process. */
  mint(req: IncomingMessage): Promise<string[]>
  chooseOrigin(req: IncomingMessage): Promise<OriginChoice>
  log: { warn(...a: unknown[]): void; debug(...a: unknown[]): void }
  pageHtml: string
  pageScript: string
  pageCsp: string
}

const MAX_BODY = 4 * 1024

function send(res: ServerResponse, status: number, body: string, headers: Record<string, string | string[]> = {}): void {
  res.writeHead(status, { 'x-content-type-options': 'nosniff', 'cache-control': 'no-store', ...headers })
  res.end(body)
}
const json = (res: ServerResponse, status: number, value: unknown, headers: Record<string, string | string[]> = {}): void =>
  send(res, status, JSON.stringify(value), { 'content-type': 'application/json; charset=utf-8', ...headers })

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (!/^application\/json\b/i.test(String(req.headers['content-type'] ?? ''))) throw new PairingError('content-type must be application/json', 415)
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).byteLength
    if (size > MAX_BODY) throw new PairingError('body too large', 413)
    chunks.push(chunk as Buffer)
  }
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    return value !== null && typeof value === 'object' ? value as Record<string, unknown> : {}
  } catch { throw new PairingError('invalid JSON') }
}

function clientKey(req: IncomingMessage): string {
  return req.socket?.remoteAddress ?? 'unknown'
}

export function registerPairing(d: PairDeps): void {
  const methods = (req: IncomingMessage, res: ServerResponse, allowed: readonly string[]): boolean => {
    if (req.method !== undefined && allowed.includes(req.method)) return true
    send(res, 405, '', { allow: allowed.join(', ') })
    return false
  }
  const mutation = (req: IncomingMessage, res: ServerResponse): boolean => {
    if (!methods(req, res, ['POST'])) return false
    if (d.rejected(req, res)) return false
    if (!d.sameOrigin(req) || req.headers['sec-fetch-site'] === 'cross-site') { send(res, 403, 'cross-site request rejected', { 'content-type': 'text/plain; charset=utf-8' }); return false }
    return true
  }
  const fail = (res: ServerResponse, error: unknown): void => {
    if (error instanceof PairingError) { json(res, error.status, { ok: false, error: error.message }); return }
    d.log.warn('pairing request failed', (error as Error).message)
    json(res, 500, { ok: false, error: 'pairing failed' })
  }

  d.route({ kind: 'exact', path: '/pair/code', handler: async (req, res) => {
    if (!mutation(req, res)) return
    try {
      const issued = d.codes.issue()
      const choice = await d.chooseOrigin(req)
      json(res, 200, { ok: true, expiresAt: issued.expiresAt, origin: choice.origin, kind: choice.kind, secure: choice.secure, warnings: choice.warnings, links: pairLinks(choice.origin, issued.code) })
    } catch (error) { fail(res, error) }
  } })

  d.route({ kind: 'exact', path: '/pair/devices', handler: async (req, res) => {
    if (!methods(req, res, ['GET'])) return
    if (d.rejected(req, res)) return
    try { json(res, 200, { ok: true, devices: await d.store.list() }) } catch (error) { fail(res, error) }
  } })

  d.route({ kind: 'exact', path: '/pair/remove', handler: async (req, res) => {
    if (!mutation(req, res)) return
    try {
      const body = await readBody(req)
      const id = body['id']
      if (typeof id !== 'string' || !/^[a-f0-9]{24}$/.test(id)) throw new PairingError('invalid device id')
      json(res, 200, { ok: true, removed: await d.store.remove(id) })
    } catch (error) { fail(res, error) }
  } })

  // Public by necessity: the phone has no credential yet. Safe because the code is 128 random bits, single use, expires in
  // 10 minutes, compared in constant time, and failures are rate-limited (a blocked caller is refused even with a good code).
  d.route({ kind: 'exact', path: '/pair/claim', handler: async (req, res) => {
    if (!methods(req, res, ['POST'])) return
    if (d.untrusted(req)) { send(res, 403, 'Forbidden', { 'content-type': 'text/plain; charset=utf-8' }); return }
    const key = clientKey(req)
    const wait = d.claimLimiter.retryAfter(key)
    if (wait > 0) { json(res, 429, { ok: false, error: 'too many attempts; wait and try again' }, { 'retry-after': String(wait) }); return }
    try {
      const body = await readBody(req)
      const code = typeof body['code'] === 'string' ? body['code'] : ''
      if (!d.codes.consume(code)) {
        d.claimLimiter.fail(key)
        json(res, 401, { ok: false, error: 'this pairing code is invalid, expired or already used; make a new one in Settings > Phone app' })
        return
      }
      const cookieMode = body['mode'] === 'cookie'
      // Mint first: if DSH refuses this address nothing is registered and the code is already spent (make a new one).
      const cookies = cookieMode ? await d.mint(req) : []
      const { device, token } = await d.store.add(cleanDeviceName(body['deviceName']))
      d.log.debug('device paired', device.id)
      if (cookieMode) {
        await d.store.recordSession(device.id, cookies)
        json(res, 200, { ok: true, device }, { 'set-cookie': cookies })
        return
      }
      json(res, 200, { ok: true, device, token })
    } catch (error) { fail(res, error) }
  } })

  d.route({ kind: 'exact', path: '/pair/session', handler: async (req, res) => {
    if (!methods(req, res, ['GET', 'HEAD'])) return
    if (d.untrusted(req)) { send(res, 403, 'Forbidden', { 'content-type': 'text/plain; charset=utf-8' }); return }
    const key = clientKey(req)
    const wait = d.sessionLimiter.retryAfter(key)
    if (wait > 0) { json(res, 429, { ok: false, error: 'too many attempts' }, { 'retry-after': String(wait) }); return }
    const token = bearerToken(req.headers['authorization'])
    const device = token === undefined ? undefined : await d.store.authenticate(token)
    if (device === undefined) {
      if (token !== undefined) d.sessionLimiter.fail(key)
      json(res, 401, { ok: false, error: 'this device is not paired (any more)' })
      return
    }
    try {
      const cookies = await d.mint(req)
      await d.store.recordSession(device.id, cookies)
      send(res, 303, '', { location: '/', 'referrer-policy': 'no-referrer', 'set-cookie': cookies })
    } catch (error) {
      d.log.warn('session exchange failed', (error as Error).message)
      json(res, 502, { ok: false, error: (error as Error).message })
    }
  } })

  const page = (path: string, type: string, body: string, extra: Record<string, string> = {}): void => d.route({
    kind: 'exact', path,
    handler: (req, res) => {
      if (!methods(req, res, ['GET', 'HEAD'])) return
      send(res, 200, req.method === 'HEAD' ? '' : body, { 'content-type': type, ...extra })
    },
  })
  page('/app/pair', 'text/html; charset=utf-8', d.pageHtml, { 'content-security-policy': d.pageCsp, 'referrer-policy': 'no-referrer' })
  page('/app/pair.js', 'text/javascript; charset=utf-8', d.pageScript)
}
