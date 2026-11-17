// @vitest-environment node
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { CODE_TTL_MS, CodeBook, DEVICE_TOKEN_PREFIX, DeviceStore, FailureLimiter, MAX_DEVICES, MAX_OUTSTANDING_CODES, authCookieValue, bearerToken, cleanDeviceName, secretsEqual } from '../src/host/pairing.ts'
import { chooseOrigin, isLoopbackAuthority, pairLinks, tailscaleFacts } from '../src/host/origin.ts'
import { registerPairing, type PairDeps } from '../src/host/pair-routes.ts'
import { apply } from '../src/host/index.ts'
import { EventEmitter } from 'node:events'
import { installAdmitGate, trackDeviceSockets } from '../src/host/revocation.ts'

const tmp = mkdtempSync(join(tmpdir(), 'pwa-pair-'))
afterAll(() => { rmSync(tmp, { recursive: true, force: true }) })

describe('one-time codes', () => {
  it('are 128-bit url-safe, valid once, and expire after 10 minutes', () => {
    let t = 1_000_000
    const book = new CodeBook(() => t)
    const { code, expiresAt } = book.issue()
    expect(code).toMatch(/^[A-Za-z0-9_-]{22}$/); expect(expiresAt - t).toBe(CODE_TTL_MS)
    expect(book.consume(code)).toBe(true)
    expect(book.consume(code)).toBe(false) // single use
    const second = book.issue().code
    t += CODE_TTL_MS - 1
    expect(book.outstanding()).toBe(1)
    t += 1
    expect(book.consume(second)).toBe(false) // expired exactly at the boundary
    expect(book.outstanding()).toBe(0)
  })
  it('rejects wrong, short, long and empty codes and never accepts a prefix', () => {
    const book = new CodeBook()
    const { code } = book.issue()
    for (const bad of ['', 'x', code.slice(0, 21), code + 'A', code.toUpperCase() === code ? code.toLowerCase() : code.toUpperCase(), 'A'.repeat(65)]) expect(book.consume(bad), bad).toBe(false)
    expect(book.consume(code)).toBe(true)
  })
  it('keeps at most 3 outstanding codes, dropping the oldest', () => {
    const book = new CodeBook()
    const codes = Array.from({ length: MAX_OUTSTANDING_CODES + 2 }, () => book.issue().code)
    expect(book.outstanding()).toBe(MAX_OUTSTANDING_CODES)
    expect(book.consume(codes[0]!)).toBe(false); expect(book.consume(codes.at(-1)!)).toBe(true)
  })
  it('uses constant-time comparison (hash then timingSafeEqual) for secrets of any length', () => {
    expect(secretsEqual('abc', 'abc')).toBe(true); expect(secretsEqual('abc', 'abd')).toBe(false); expect(secretsEqual('abc', 'abcd')).toBe(false)
    const source = readFileSync(new URL('../src/host/pairing.ts', import.meta.url), 'utf8')
    expect(source).toMatch(/timingSafeEqual\(sha256\(a\), sha256\(b\)\)/)
    expect(source).not.toMatch(/(code|token|secret)\s*===\s*\w+|\.includes\(code\)/)
  })
})

describe('rate limiter', () => {
  it('blocks a key after N failures, expires the window, and counts globally', () => {
    let t = 0
    const lim = new FailureLimiter(3, 5, 60_000, () => t)
    for (let i = 0; i < 3; i += 1) { expect(lim.retryAfter('a')).toBe(0); lim.fail('a') }
    expect(lim.retryAfter('a')).toBeGreaterThan(0)
    expect(lim.retryAfter('b')).toBe(0)
    t += 60_001
    expect(lim.retryAfter('a')).toBe(0)
    for (let i = 0; i < 5; i += 1) lim.fail(`k${i}`)
    expect(lim.retryAfter('fresh')).toBeGreaterThan(0) // global window
  })
})

describe('device store', () => {
  it('stores only a hash (0600), authenticates the token, never the hash, and revokes', async () => {
    const file = join(tmp, 'a', 'devices.json')
    const store = new DeviceStore(file)
    const { device, token } = await store.add('  Pixel <b>8</b>\n')
    expect(token.startsWith(DEVICE_TOKEN_PREFIX)).toBe(true); expect(Buffer.from(token.slice(DEVICE_TOKEN_PREFIX.length), 'base64url')).toHaveLength(32)
    expect(device.name).toBe('Pixel b8/b')
    const raw = readFileSync(file, 'utf8')
    expect(raw).not.toContain(token); expect(raw).toMatch(/"tokenHash":"[a-f0-9]{64}"/); expect(statSync(file).mode & 0o777).toBe(0o600)
    expect((await store.authenticate(token))?.id).toBe(device.id)
    expect(await store.authenticate(token + 'x')).toBeUndefined()
    expect(await store.authenticate(token.slice(0, -1))).toBeUndefined()
    expect(await store.authenticate(JSON.parse(raw).devices[0].tokenHash)).toBeUndefined() // the stored hash is not a credential
    expect(await store.remove(device.id)).toBe(true)
    expect(await store.authenticate(token)).toBeUndefined()
    expect(await store.remove(device.id)).toBe(false)
    expect(await new DeviceStore(file).list()).toEqual([]) // survives a restart
  })
  it('tracks lastSeen, lists newest first and caps the number of devices', async () => {
    let t = 1000
    const store = new DeviceStore(join(tmp, 'b', 'devices.json'), () => t)
    const first = await store.add('one'); t += 5; const second = await store.add('two')
    expect((await store.list()).map((d) => d.name)).toEqual(['two', 'one'])
    t += 120_000
    await store.authenticate(first.token)
    expect((await store.list()).find((d) => d.name === 'one')?.lastSeen).toBe(t)
    void second
    for (let i = 2; i < MAX_DEVICES; i += 1) await store.add(`d${i}`)
    await expect(store.add('overflow')).rejects.toMatchObject({ status: 409 })
  })
  it('revoking a device refuses exactly the sign-in cookies minted for it', async () => {
    const store = new DeviceStore(join(tmp, 'c', 'devices.json'))
    const { device } = await store.add('phone')
    const other = await store.add('tablet')
    const line = (v: string): string => `dsh-auth-XYZ=${v}; Max-Age=2592000; Path=/; HttpOnly; SameSite=Strict`
    expect(authCookieValue(line('v1.abc.def'))).toBe('v1.abc.def'); expect(authCookieValue('other=1')).toBeUndefined()
    await store.recordSession(device.id, [line('v1.phone.sig')]); await store.recordSession(other.device.id, [line('v1.tablet.sig')])
    expect(store.isRevokedCookie('dsh-auth-XYZ=v1.phone.sig')).toBe(false)
    await store.remove(device.id)
    expect(store.isRevokedCookie('x=1; dsh-auth-XYZ=v1.phone.sig')).toBe(true)
    expect(store.isRevokedCookie('dsh-auth-XYZ=v1.tablet.sig')).toBe(false)
    expect(store.isRevokedCookie(undefined)).toBe(false)
    const reloaded = new DeviceStore(join(tmp, 'c', 'devices.json')); await reloaded.warm()
    expect(reloaded.isRevokedCookie('dsh-auth-XYZ=v1.phone.sig')).toBe(true) // persisted across restarts
  })
  it('helpers: names, bearer header', () => {
    expect(cleanDeviceName('')).toBe('Phone'); expect(cleanDeviceName(5)).toBe('Phone'); expect(cleanDeviceName('a'.repeat(100))).toHaveLength(60)
    expect(bearerToken('Bearer abcdefgh12')).toBe('abcdefgh12'); expect(bearerToken('Basic abc')).toBeUndefined(); expect(bearerToken(undefined)).toBeUndefined()
  })
})

describe('address choice', () => {
  const ifaces = { lo: [{ address: '127.0.0.1', family: 'IPv4', internal: true }], ts0: [{ address: '100.88.1.2', family: 'IPv4', internal: false }], wlan0: [{ address: '192.168.1.23', family: 'IPv4', internal: false }] }
  const tsStatus = JSON.stringify({ BackendState: 'Running', Self: { DNSName: 'laptop.tail1234.ts.net.' } })
  const serve = (port: number) => JSON.stringify({ Web: { 'laptop.tail1234.ts.net:443': { Handlers: { '/': { Proxy: `http://127.0.0.1:${port}` } } } } })
  const exec = (status: string, serveJson: string) => async (_f: string, args: string[]) => { if (args[0] === 'status') return status; if (serveJson === '') throw new Error('none'); return serveJson }
  const bind = { host: '127.0.0.1', port: 3080, protocol: 'http:' as const }

  it('prefers the Tailscale HTTPS name when tailscale serve proxies this DSH', async () => {
    const c = await chooseOrigin({ bind, requestHost: '127.0.0.1:3080', exec: exec(tsStatus, serve(3080)), interfaces: () => ifaces })
    expect(c).toMatchObject({ origin: 'https://laptop.tail1234.ts.net', kind: 'tailscale', secure: true })
  })
  it('keeps the address the page is open at when it is not loopback', async () => {
    expect(await chooseOrigin({ bind, requestHost: 'laptop.tail1234.ts.net', exec: exec('{}', ''), interfaces: () => ifaces })).toMatchObject({ origin: 'https://laptop.tail1234.ts.net', kind: 'tailscale', secure: true })
    expect(await chooseOrigin({ bind, requestHost: '192.168.1.23:3080', exec: exec('{}', ''), interfaces: () => ifaces })).toMatchObject({ origin: 'http://192.168.1.23:3080', kind: 'request', secure: false })
  })
  it('falls back to the LAN IP (never the Tailscale 100.x address) and warns about http and a loopback bind', async () => {
    const c = await chooseOrigin({ bind, requestHost: '127.0.0.1:3080', exec: exec('{}', ''), interfaces: () => ifaces })
    expect(c.origin).toBe('http://192.168.1.23:3080'); expect(c.kind).toBe('lan'); expect(c.secure).toBe(false)
    expect(c.warnings.join(' ')).toMatch(/only inside the ohmydsh app/); expect(c.warnings.join(' ')).toMatch(/listens on 127\.0\.0\.1 only/)
    const bound = await chooseOrigin({ bind: { ...bind, host: '192.168.1.23' }, requestHost: undefined, exec: exec('{}', ''), interfaces: () => ifaces })
    expect(bound.warnings.join(' ')).not.toMatch(/listens on/)
  })
  it('tailscale running but not serving DSH: LAN wins; with no LAN it explains the serve command', async () => {
    expect((await chooseOrigin({ bind, requestHost: undefined, exec: exec(tsStatus, ''), interfaces: () => ifaces })).kind).toBe('lan')
    const c = await chooseOrigin({ bind, requestHost: undefined, exec: exec(tsStatus, ''), interfaces: () => ({ lo: ifaces.lo }) })
    expect(c.warnings.join(' ')).toMatch(/tailscale serve --bg --https=443 http:\/\/127\.0\.0\.1:3080/)
  })
  it('tailscale facts: absent, stopped, other port', async () => {
    expect(await tailscaleFacts(3080, async () => { throw new Error('ENOENT') })).toBeUndefined()
    expect(await tailscaleFacts(3080, exec(JSON.stringify({ BackendState: 'Stopped' }), ''))).toBeUndefined()
    expect((await tailscaleFacts(3080, exec(tsStatus, serve(9999))))?.serving).toBe(false)
  })
  it('builds the app link and the https fallback; loopback detection', () => {
    expect(pairLinks('https://x.ts.net', 'CODE-1_a')).toEqual({ app: 'ohmydsh://pair?u=https%3A%2F%2Fx.ts.net&c=CODE-1_a', web: 'https://x.ts.net/app/pair#CODE-1_a' })
    expect(isLoopbackAuthority('localhost:3080')).toBe(true); expect(isLoopbackAuthority('[::1]:3080')).toBe(true); expect(isLoopbackAuthority('192.168.1.2')).toBe(false)
  })
})

// ── routes ──
interface Out { status: number; headers: Record<string, string | string[]>; body: string }
function harness(over: Partial<PairDeps> = {}, opts: { signedIn?: boolean; trusted?: boolean } = {}) {
  const routes = new Map<string, (req: any, res: any) => unknown>() // eslint-disable-line
  let seq = 0
  const store = new DeviceStore(join(tmp, `r${seq += 1}-${Math.random().toString(16).slice(2)}`, 'devices.json'))
  const minted: string[] = []
  const deps: PairDeps = {
    store, codes: new CodeBook(), claimLimiter: new FailureLimiter(5, 30, 600_000), sessionLimiter: new FailureLimiter(3, 100, 600_000),
    route: (r) => { routes.set(r.path, r.handler) },
    rejected: (_req, res) => { if (opts.signedIn === false) { res.writeHead(401, {}); res.end('no'); return true } return false },
    untrusted: () => opts.trusted === false,
    sameOrigin: (req) => req.headers['origin'] === undefined || new URL(req.headers['origin'] as string).host === req.headers['host'],
    mint: async () => { const line = `dsh-auth-HOST=v1.${minted.length}.sig; Max-Age=2592000; Path=/; HttpOnly; SameSite=Strict`; minted.push(line); return [line] },
    chooseOrigin: async () => ({ origin: 'https://laptop.ts.net', kind: 'tailscale', secure: true, warnings: [] }),
    log: { warn: vi.fn(), debug: vi.fn() }, pageHtml: '<html/>', pageScript: '//', pageCsp: "default-src 'none'", ...over,
  }
  registerPairing(deps)
  const call = async (path: string, init: { method?: string; headers?: Record<string, string>; body?: unknown; ip?: string } = {}): Promise<Out> => {
    const raw = init.body === undefined ? [] : [Buffer.from(JSON.stringify(init.body))]
    const req = Object.assign(Readable.from(raw), { method: init.method ?? 'GET', url: path, socket: { remoteAddress: init.ip ?? '10.0.0.5' }, headers: { host: 'laptop.ts.net', origin: 'https://laptop.ts.net', 'content-type': 'application/json', ...init.headers } })
    const out: Out = { status: 0, headers: {}, body: '' }
    await routes.get(path)!(req, { writeHead: (s: number, h: Record<string, string>) => { out.status = s; out.headers = h ?? {} }, end: (b?: string) => { out.body = b ?? '' } })
    return out
  }
  return { call, deps, store, minted, routes }
}

describe('pairing routes', () => {
  it('end to end: code -> claim -> device token -> session cookie -> revoke -> 401', async () => {
    const h = harness()
    const made = await h.call('/pair/code', { method: 'POST', body: {} })
    expect(made.status).toBe(200)
    const info = JSON.parse(made.body)
    const code = new URL(info.links.app).searchParams.get('c')!
    expect(info.links.web).toBe(`https://laptop.ts.net/app/pair#${code}`); expect(info.expiresAt).toBeGreaterThan(Date.now())
    const claim = await h.call('/pair/claim', { method: 'POST', body: { code, deviceName: 'Pixel 8' }, headers: { origin: 'http://localhost' } })
    expect(claim.status).toBe(200)
    const { token, device } = JSON.parse(claim.body)
    expect(token).toMatch(/^dsh-dev_/); expect(device.name).toBe('Pixel 8')
    expect(claim.headers['set-cookie']).toBeUndefined() // a native app gets a token, not a cookie
    const session = await h.call('/pair/session', { headers: { authorization: `Bearer ${token}` } })
    expect(session.status).toBe(303); expect(session.headers['location']).toBe('/')
    expect(String((session.headers['set-cookie'] as string[])[0])).toMatch(/^dsh-auth-HOST=.*HttpOnly.*SameSite=Strict/)
    expect(session.body).toBe('')
    expect(JSON.parse((await h.call('/pair/devices')).body).devices).toHaveLength(1)
    expect(h.store.isRevokedCookie('dsh-auth-HOST=v1.0.sig')).toBe(false)
    expect(JSON.parse((await h.call('/pair/remove', { method: 'POST', body: { id: device.id } })).body).removed).toBe(true)
    expect((await h.call('/pair/session', { headers: { authorization: `Bearer ${token}` } })).status).toBe(401)
    expect(h.store.isRevokedCookie('dsh-auth-HOST=v1.0.sig')).toBe(true)
    expect(JSON.parse((await h.call('/pair/devices')).body).devices).toEqual([])
  })
  it('a code is single use and an expired code is refused', async () => {
    let t = 0
    const h = harness({ codes: new CodeBook(() => t) })
    const code = h.deps.codes.issue().code
    expect((await h.call('/pair/claim', { method: 'POST', body: { code } })).status).toBe(200)
    expect((await h.call('/pair/claim', { method: 'POST', body: { code } })).status).toBe(401)
    const late = h.deps.codes.issue().code
    t += CODE_TTL_MS
    expect((await h.call('/pair/claim', { method: 'POST', body: { code: late } })).status).toBe(401)
  })
  it('claim is public but rate-limited: 5 wrong codes block the caller even with a good one, other callers are unaffected', async () => {
    const h = harness()
    for (let i = 0; i < 5; i += 1) expect((await h.call('/pair/claim', { method: 'POST', body: { code: `wrong-${i}-wrong-wrong-xx` }, ip: '9.9.9.9' })).status).toBe(401)
    const good = h.deps.codes.issue().code
    const blocked = await h.call('/pair/claim', { method: 'POST', body: { code: good }, ip: '9.9.9.9' })
    expect(blocked.status).toBe(429); expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0)
    expect((await h.call('/pair/claim', { method: 'POST', body: { code: good }, ip: '8.8.8.8' })).status).toBe(200) // the code was not burned by the blocked attempt
  })
  it('the session route rate-limits wrong tokens too, and never leaks the token', async () => {
    const h = harness()
    for (let i = 0; i < 3; i += 1) expect((await h.call('/pair/session', { headers: { authorization: 'Bearer dsh-dev_wrongwrongwrong' } })).status).toBe(401)
    expect((await h.call('/pair/session', { headers: { authorization: 'Bearer dsh-dev_wrongwrongwrong' } })).status).toBe(429)
    expect((await h.call('/pair/session', { ip: '7.7.7.7' })).status).toBe(401) // no token at all: refused, not counted
  })
  it('claim with mode=cookie signs the browser in (cookie only, no token in the body)', async () => {
    const h = harness()
    const code = h.deps.codes.issue().code
    const r = await h.call('/pair/claim', { method: 'POST', body: { code, mode: 'cookie', deviceName: 'Browser' } })
    expect(r.status).toBe(200); expect(r.body).not.toMatch(/dsh-dev_/); expect(String((r.headers['set-cookie'] as string[])[0])).toContain('HttpOnly')
  })
  it('signed-in routes fail closed and refuse cross-site mutations; public routes still honour the Host fence', async () => {
    const out = harness({}, { signedIn: false })
    for (const [path, method] of [['/pair/code', 'POST'], ['/pair/devices', 'GET'], ['/pair/remove', 'POST']] as const) expect((await out.call(path, { method })).status, path).toBe(401)
    const h = harness()
    for (const path of ['/pair/code', '/pair/remove']) {
      expect((await h.call(path, { method: 'POST', body: {}, headers: { origin: 'https://evil.example' } })).status, path).toBe(403)
      expect((await h.call(path, { method: 'POST', body: {}, headers: { 'sec-fetch-site': 'cross-site' } })).status, path).toBe(403)
    }
    const untrusted = harness({}, { trusted: false })
    expect((await untrusted.call('/pair/claim', { method: 'POST', body: { code: 'x' } })).status).toBe(403)
    expect((await untrusted.call('/pair/session', { headers: { authorization: 'Bearer dsh-dev_xxxxxxxxxx' } })).status).toBe(403)
  })
  it('validates input: methods, content type, size, device ids; never logs secrets', async () => {
    const h = harness()
    expect((await h.call('/pair/claim', { method: 'GET' })).status).toBe(405)
    expect((await h.call('/pair/claim', { method: 'POST', body: {}, headers: { 'content-type': 'text/plain' } })).status).toBe(415)
    expect((await h.call('/pair/remove', { method: 'POST', body: { id: '../x' } })).status).toBe(400)
    expect((await h.call('/pair/remove', { method: 'POST', body: { id: 'a'.repeat(24) } })).status).toBe(200)
    const code = h.deps.codes.issue().code
    const claim = JSON.parse((await h.call('/pair/claim', { method: 'POST', body: { code, deviceName: 'x' } })).body)
    await h.call('/pair/session', { headers: { authorization: `Bearer ${claim.token}` } })
    const logged = JSON.stringify([...(h.deps.log.warn as ReturnType<typeof vi.fn>).mock.calls, ...(h.deps.log.debug as ReturnType<typeof vi.fn>).mock.calls])
    expect(logged).not.toContain(code); expect(logged).not.toContain(claim.token)
  })
  it('a failing mint (address DSH does not trust) registers no device and reports why', async () => {
    const h = harness({ mint: async () => { throw new Error('DSH did not sign this address in') } })
    const code = h.deps.codes.issue().code
    const r = await h.call('/pair/claim', { method: 'POST', body: { code, mode: 'cookie' } })
    expect(r.status).toBe(500); expect(await h.store.list()).toEqual([])
  })
  it('serves the public landing page with a strict CSP', async () => {
    const h = harness({}, { signedIn: false })
    const page = await h.call('/app/pair')
    expect(page.status).toBe(200); expect(page.headers['content-security-policy']).toContain("default-src 'none'"); expect(page.headers['cache-control']).toBe('no-store')
  })
})

describe('host wiring', () => {
  it('registers the pairing routes, refuses revoked cookies at the gate, and pairing:false removes them', async () => {
    const home = mkdtempSync(join(tmp, 'home-'))
    process.env['DSH_HOME'] = home
    const boot = (config: unknown) => {
      const routes = new Map<string, (req: any, res: any) => Promise<void> | void>() // eslint-disable-line
      const upgrade = new EventEmitter()
      const ctx = {
        effect: (fn: () => unknown) => { fn() },
        on: () => () => {},
        webServer: { register: (r: { kind: string; path: string; handler: never }) => { routes.set(r.path, r.handler); return () => {} }, host: '127.0.0.1', port: 3080, protocol: 'http:', server: upgrade },
        connection: {
          requestRejection: () => undefined,
          admit: () => ({ peer: {} }),
          authenticatedUrl: (u: string) => `${u}?token=LAUNCHTOKEN`,
          authorizeIndex: (req: { url?: string }, res: { writeHead(s: number, h: Record<string, string>): void; end(): void }) => { expect(req.url).toContain('LAUNCHTOKEN'); res.writeHead(303, { location: './', 'set-cookie': 'dsh-auth-H=v1.cookie.sig; Path=/; HttpOnly; SameSite=Strict' }); res.end(); return false },
        },
        logger: () => ({ warn() {}, debug() {} }),
      }
      apply(ctx as never, config)
      return { routes, connection: ctx.connection as unknown as { admit(request: { headers: unknown }): unknown; authorizeIndex(request: object, response: object): boolean }, upgrade }
    }
    const on = boot({})
    for (const p of ['/pair/code', '/pair/devices', '/pair/remove', '/pair/claim', '/pair/session', '/app/pair', '/app/pair.js']) expect(on.routes.has(p), p).toBe(true)
    expect([...boot({ pairing: { enabled: false } }).routes.keys()].some((k) => k.startsWith('/pair'))).toBe(false)
    const run = async (path: string, req: object): Promise<Out> => {
      const out: Out = { status: 0, headers: {}, body: '' }
      await on.routes.get(path)!(Object.assign(req, { socket: { remoteAddress: '1.1.1.1' }, headers: { host: '127.0.0.1:3080', ...((req as { headers?: object }).headers) } }), { writeHead: (s: number, h: Record<string, string>) => { out.status = s; out.headers = h ?? {} }, end: (b?: string) => { out.body = b ?? '' } })
      return out
    }
    // pair via the real wiring: need a code, which only the signed-in route can issue
    const made = await run('/pair/code', Object.assign(Readable.from([Buffer.from('{}')]), { method: 'POST', url: '/pair/code', headers: { origin: 'http://127.0.0.1:3080', 'content-type': 'application/json' } }))
    expect(made.status).toBe(200)
    const code = new URL(JSON.parse(made.body).links.app).searchParams.get('c')!
    const claim = await run('/pair/claim', Object.assign(Readable.from([Buffer.from(JSON.stringify({ code, deviceName: 'T' }))]), { method: 'POST', url: '/pair/claim', headers: { 'content-type': 'application/json' } }))
    const { token, device } = JSON.parse(claim.body)
    const session = await run('/pair/session', { method: 'GET', url: '/pair/session', headers: { authorization: `Bearer ${token}` } })
    expect(session.status).toBe(303); expect(session.body).not.toContain('LAUNCHTOKEN'); expect(JSON.stringify(session.headers)).not.toContain('LAUNCHTOKEN')
    // core's admission lets a live device cookie through and refuses it after revoke; its open socket is closed
    const apiReq = { headers: { cookie: 'dsh-auth-H=v1.cookie.sig' } }
    expect(on.connection.admit(apiReq)).toEqual({ peer: {} })
    const socket = Object.assign(new EventEmitter(), { destroy: vi.fn() })
    on.upgrade.emit('upgrade', { headers: apiReq.headers }, socket); expect(socket.destroy).not.toHaveBeenCalled()
    await run('/pair/remove', Object.assign(Readable.from([Buffer.from(JSON.stringify({ id: device.id }))]), { method: 'POST', url: '/pair/remove', headers: { origin: 'http://127.0.0.1:3080', 'content-type': 'application/json' } }))
    expect(on.connection.admit(apiReq)).toEqual({ rejection: 401 })
    expect(on.connection.admit({ headers: new Headers({ cookie: 'dsh-auth-H=v1.cookie.sig' }) })).toEqual({ rejection: 401 })
    expect(socket.destroy).toHaveBeenCalledTimes(1)
    const shell = { status: 0 }
    expect(on.connection.authorizeIndex({ headers: apiReq.headers, url: '/' }, { writeHead: (s: number) => { shell.status = s }, end() {} })).toBe(false)
    expect(shell.status).toBe(401) // the page shell is refused too
    const late = Object.assign(new EventEmitter(), { destroy: vi.fn() })
    on.upgrade.emit('upgrade', { headers: apiReq.headers }, late); expect(late.destroy).toHaveBeenCalledTimes(1) // a revoked cookie cannot open a new socket
    expect(statSync(join(home, 'plugin-data', 'dsh-pwa', 'devices.json')).mode & 0o777).toBe(0o600)
  })
})

describe('revocation gate', () => {
  it("keeps core's own rejection (403 wins), restores the original, and ignores hosts without admit", async () => {
    const store = new DeviceStore(join(tmp, 'g', 'devices.json'))
    const target = { admit: vi.fn(() => ({ rejection: 403 })) as unknown as (r: { headers: Record<string, string> }) => unknown }
    const original = target.admit
    const off = installAdmitGate(target as never, store)
    expect(target.admit({ headers: {} })).toEqual({ rejection: 403 })
    off(); expect(target.admit).toBe(original)
    expect(() => installAdmitGate({}, store)()).not.toThrow()
  })
  it('closes only the removed device sockets', async () => {
    const store = new DeviceStore(join(tmp, 'g2', 'devices.json'))
    const a = await store.add('a'); const b = await store.add('b')
    const line = (v: string): string => `dsh-auth-X=${v}; Path=/; HttpOnly`
    await store.recordSession(a.device.id, [line('v1.a.sig')]); await store.recordSession(b.device.id, [line('v1.b.sig')])
    const server = new EventEmitter()
    const tracker = trackDeviceSockets(server as never, store)
    const mk = () => Object.assign(new EventEmitter(), { destroy: vi.fn() })
    const sa = mk(); const sb = mk(); const anon = mk()
    server.emit('upgrade', { headers: { cookie: 'dsh-auth-X=v1.a.sig' } }, sa)
    server.emit('upgrade', { headers: { cookie: 'dsh-auth-X=v1.b.sig' } }, sb)
    server.emit('upgrade', { headers: {} }, anon)
    expect(tracker.closeDevice(a.device.id)).toBe(1)
    expect(sa.destroy).toHaveBeenCalled(); expect(sb.destroy).not.toHaveBeenCalled(); expect(anon.destroy).not.toHaveBeenCalled()
    tracker.dispose()
  })
})
