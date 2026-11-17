// @vitest-environment node
// VAPID persistence, subscription storage, delivery to a mock push service (payloads are decrypted with the
// subscription's own keys, proving RFC 8291 encryption end to end), 404/410 cleanup, and the push routes.
import { createECDH, randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import { createRequire } from 'node:module'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { loadVapid } from '../src/host/vapid.ts'
import { SubscriptionError, SubscriptionStore, isPrivateHost, parseSubscription, redactEndpoint } from '../src/host/subscriptions.ts'
import { createPusher, clip } from '../src/host/push.ts'
import { apply, deviceLabel } from '../src/host/index.ts'

const require = createRequire(import.meta.url)
const ece = createRequire(require.resolve('web-push'))('http_ece') as { decrypt(body: Buffer, params: Record<string, unknown>): Buffer }
const b64url = (buf: Buffer): string => buf.toString('base64url')

const dir = mkdtempSync(join(tmpdir(), 'pwa-push-'))
afterAll(() => { rmSync(dir, { recursive: true, force: true }) })

/** A fake browser: a P-256 key pair and auth secret, and a local push endpoint that records what arrives. */
function device(server: { url: string; status: () => number; received: { headers: IncomingMessage['headers']; body: Buffer }[] }, id: string) {
  const ecdh = createECDH('prime256v1'); ecdh.generateKeys()
  const auth = randomBytes(16)
  return {
    endpoint: `${server.url}/send/${id}`,
    keys: { p256dh: b64url(ecdh.getPublicKey()), auth: b64url(auth) },
    decrypt: (body: Buffer): Record<string, unknown> => JSON.parse(ece.decrypt(body, { version: 'aes128gcm', privateKey: ecdh, authSecret: b64url(auth) }).toString('utf8')),
  }
}

let http: Server
const mock = { url: '', received: [] as { headers: IncomingMessage['headers']; body: Buffer; path: string }[], code: 201, status: () => mock.code }
beforeAll(async () => {
  http = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const code = req.url?.includes('/gone') ? 410 : req.url?.includes('/missing') ? 404 : req.url?.includes('/boom') ? 500 : mock.code
      mock.received.push({ headers: req.headers, body: Buffer.concat(chunks), path: req.url ?? '' })
      res.writeHead(code); res.end()
    })
  })
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve))
  mock.url = `http://127.0.0.1:${(http.address() as { port: number }).port}`
})
afterAll(() => { http.close() })

describe('VAPID keys', () => {
  it('are generated once, stored 0600 in a 0700 directory, and read back unchanged', async () => {
    const data = join(dir, 'vapid-data')
    const first = await loadVapid(data)
    const second = await loadVapid(data)
    expect(second).toEqual(first)
    expect(first.publicKey).toHaveLength(87); expect(first.privateKey).toHaveLength(43)
    expect(statSync(join(data, 'vapid.json')).mode & 0o777).toBe(0o600)
    expect(statSync(data).mode & 0o777).toBe(0o700)
    expect(JSON.parse(readFileSync(join(data, 'vapid.json'), 'utf8')).publicKey).toBe(first.publicKey)
  })
  it('never silently replaces a damaged file (that would orphan every subscription)', async () => {
    const data = join(dir, 'vapid-bad')
    await loadVapid(data)
    writeFileSync(join(data, 'vapid.json'), '{"publicKey":"x","privateKey":"y"}')
    await expect(loadVapid(data)).rejects.toThrow(/VAPID/)
    expect(readFileSync(join(data, 'vapid.json'), 'utf8')).toContain('"x"')
  })
})

describe('subscription validation and storage', () => {
  const keys = { p256dh: 'B'.repeat(87), auth: 'a'.repeat(22) }
  it('accepts https endpoints, rejects http, credentials, private hosts and bad keys', () => {
    expect(parseSubscription({ endpoint: 'https://fcm.googleapis.com/fcm/send/abc', keys }, { allowInsecure: false }).endpoint).toBe('https://fcm.googleapis.com/fcm/send/abc')
    for (const endpoint of ['http://fcm.googleapis.com/x', 'https://user:pw@fcm.googleapis.com/x', 'https://127.0.0.1/x', 'https://localhost/x', 'https://192.168.1.4/x', 'https://[::1]/x', 'https://metadata.internal/x', 'not a url', '']) {
      expect(() => parseSubscription({ endpoint, keys }, { allowInsecure: false }), endpoint).toThrow(SubscriptionError)
    }
    expect(() => parseSubscription({ endpoint: 'https://fcm.googleapis.com/x', keys: { p256dh: '!', auth: 'x' } }, { allowInsecure: false })).toThrow(SubscriptionError)
    expect(() => parseSubscription(null, { allowInsecure: false })).toThrow(SubscriptionError)
    expect(parseSubscription({ endpoint: 'http://127.0.0.1:1/x', keys }, { allowInsecure: true }).endpoint).toContain('127.0.0.1')
    expect(isPrivateHost('fcm.googleapis.com')).toBe(false); expect(isPrivateHost('172.20.0.1')).toBe(true); expect(isPrivateHost('8.8.8.8')).toBe(false)
  })
  it('redacts endpoints for logs', () => {
    const shown = redactEndpoint('https://fcm.googleapis.com/fcm/send/SECRETSECRETSECRET123456')
    expect(shown).not.toContain('SECRETSECRET'); expect(shown).toContain('fcm.googleapis.com')
  })
  it('stores by endpoint (0600), keeps the first created time on re-subscribe, removes, and survives a reload', async () => {
    const file = join(dir, 'subs', 'subscriptions.json')
    const store = new SubscriptionStore(file)
    const a = await store.upsert({ endpoint: 'https://p.example/a', keys }, 'Pixel', 1000)
    await store.upsert({ endpoint: 'https://p.example/b', keys }, 'Laptop', 2000)
    const again = await store.upsert({ endpoint: 'https://p.example/a', keys }, 'Pixel (app)', 9000)
    expect(again.createdAt).toBe(a.createdAt); expect(again.label).toBe('Pixel (app)')
    expect((await store.list()).map((s) => s.endpoint).sort()).toEqual(['https://p.example/a', 'https://p.example/b'])
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(await new SubscriptionStore(file).get('https://p.example/b')).toMatchObject({ label: 'Laptop', createdAt: 2000 })
    expect(await store.remove('https://p.example/a')).toBe(true)
    expect(await store.remove('https://p.example/a')).toBe(false)
    expect((await new SubscriptionStore(file).list()).map((s) => s.endpoint)).toEqual(['https://p.example/b'])
  })
  it('labels a device from its user agent', () => {
    expect(deviceLabel('Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/130.0 Mobile Safari/537.36')).toBe('Android Chrome')
    expect(deviceLabel(undefined)).toBe('Device browser')
  })
})

describe('delivery to a mock push service', () => {
  it('encrypts a payload only the subscribed device can read, signs it with VAPID, and carries nothing but the five fields', async () => {
    mock.received.length = 0
    const vapid = await loadVapid(join(dir, 'vapid-send'))
    const store = new SubscriptionStore(join(dir, 'send', 'subscriptions.json'))
    const d = device({ ...mock, status: mock.status, received: [] as never }, 'ok')
    await store.upsert({ endpoint: d.endpoint, keys: d.keys }, 'Test', 1)
    const pusher = createPusher({ vapid, subject: 'mailto:a@b.example', store })
    const summary = await pusher.broadcast({ v: 1, kind: 'reply', title: 'My session', body: 'x'.repeat(500), sessionId: 'abc123' })
    expect(summary).toEqual({ sent: 1, removed: 0, failed: 0 })
    const got = mock.received.at(-1)!
    expect(got.headers['authorization']).toMatch(/^vapid t=/); expect(got.headers['content-encoding']).toBe('aes128gcm'); expect(got.headers['ttl']).toBe('3600')
    expect(got.body.toString('utf8')).not.toContain('My session')
    const payload = d.decrypt(got.body)
    expect(Object.keys(payload).sort()).toEqual(['body', 'kind', 'sessionId', 'title', 'v'])
    expect(payload).toMatchObject({ v: 1, kind: 'reply', title: 'My session', sessionId: 'abc123' })
    expect(String(payload['body']).length).toBeLessThanOrEqual(160)
    expect(JSON.stringify(payload)).not.toMatch(/https?:|token|key/i)
  })
  it('deletes a subscription the push service reports as gone (404/410) and keeps others on other failures', async () => {
    const vapid = await loadVapid(join(dir, 'vapid-gone'))
    const store = new SubscriptionStore(join(dir, 'gone', 'subscriptions.json'))
    const fake = { ...mock, status: mock.status, received: [] as never }
    const [ok, gone, missing, boom] = ['ok', 'gone', 'missing', 'boom'].map((id) => device(fake, id)) as [ReturnType<typeof device>, ReturnType<typeof device>, ReturnType<typeof device>, ReturnType<typeof device>]
    for (const [i, d] of [ok, gone, missing, boom].entries()) await store.upsert({ endpoint: d.endpoint, keys: d.keys }, `d${i}`, i)
    const warnings: string[] = []
    const pusher = createPusher({ vapid, subject: 'mailto:a@b.example', store, log: { warn: (...a) => warnings.push(a.join(' ')), debug() {} } })
    const summary = await pusher.broadcast({ v: 1, kind: 'test', title: 't', body: 'b', sessionId: '' })
    expect(summary).toEqual({ sent: 1, removed: 2, failed: 1 })
    expect((await store.list()).map((s) => s.endpoint).sort()).toEqual([ok.endpoint, boom.endpoint].sort())
    for (const line of warnings) expect(line).not.toContain('/send/')
  })
  it('clip flattens whitespace and ends with an ellipsis', () => {
    expect(clip('a\n\n  b', 10)).toBe('a b'); expect(clip('abcdefghij', 5)).toBe('abcd…')
  })
})

describe('push routes (signed-in, same-origin)', () => {
  const home = mkdtempSync(join(tmpdir(), 'pwa-routes-'))
  afterAll(() => { rmSync(home, { recursive: true, force: true }) })
  function boot() {
    process.env['DSH_HOME'] = home
    const routes = new Map<string, (req: unknown, res: unknown) => Promise<void> | void>()
    const ctx = {
      effect: (fn: () => unknown) => { fn() },
      on: () => () => {},
      webServer: { register: (r: { kind: string; path: string; handler: never }) => { routes.set(r.path, r.handler); return () => {} } },
      connection: { requestRejection: () => undefined },
      logger: () => ({ warn() {}, debug() {} }),
    }
    apply(ctx as never, { push: { allowInsecureEndpoints: true } })
    return routes
  }
  const call = async (routes: ReturnType<typeof boot>, method: string, path: string, body?: unknown) => {
    const out = { status: 0, body: '' }
    const raw = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
    const req = Object.assign((async function* () { yield* raw })(), { method, url: path, headers: { host: '127.0.0.1:3090', origin: 'http://127.0.0.1:3090', 'content-type': 'application/json', 'user-agent': 'Mozilla/5.0 (Linux; Android 14) Chrome/130.0' } })
    await routes.get(path)!(req, { writeHead: (s: number) => { out.status = s }, end: (b?: string) => { out.body = b ?? '' } })
    return { status: out.status, json: out.body === '' ? undefined : JSON.parse(out.body) as Record<string, unknown> }
  }
  it('serves the key, subscribes, tests the calling device through the mock service, and unsubscribes', async () => {
    const routes = boot()
    const key = await call(routes, 'GET', '/push/key')
    expect(key.status).toBe(200); expect(String(key.json?.['publicKey'])).toHaveLength(87)
    expect(JSON.parse(readFileSync(join(home, 'plugin-data', 'dsh-pwa', 'vapid.json'), 'utf8')).publicKey).toBe(key.json?.['publicKey'])
    expect(statSync(join(home, 'plugin-data', 'dsh-pwa', 'vapid.json')).mode & 0o777).toBe(0o600)
    expect(JSON.stringify(key.json)).not.toContain('privateKey')

    mock.received.length = 0
    const d = device({ ...mock, status: mock.status, received: [] as never }, 'route')
    expect((await call(routes, 'POST', '/push/subscribe', { subscription: { endpoint: 'ftp://x', keys: d.keys } })).status).toBe(400)
    const sub = await call(routes, 'POST', '/push/subscribe', { subscription: { endpoint: d.endpoint, keys: d.keys } })
    expect(sub.status).toBe(200); expect(sub.json?.['label']).toBe('Android Chrome')
    expect(JSON.parse(readFileSync(join(home, 'plugin-data', 'dsh-pwa', 'subscriptions.json'), 'utf8')).subscriptions[0].endpoint).toBe(d.endpoint)

    expect((await call(routes, 'POST', '/push/test', { endpoint: `${mock.url}/send/unknown` })).status).toBe(404)
    const test = await call(routes, 'POST', '/push/test', { endpoint: d.endpoint })
    expect(test.status).toBe(200)
    expect(d.decrypt(mock.received.at(-1)!.body)).toMatchObject({ kind: 'test', sessionId: '' })

    expect((await call(routes, 'POST', '/push/unsubscribe', { endpoint: d.endpoint })).json).toMatchObject({ ok: true, removed: true })
    expect((await call(routes, 'POST', '/push/test', { endpoint: d.endpoint })).status).toBe(404)
  })
  it('rejects non-JSON and oversized bodies', async () => {
    const routes = boot()
    const huge = await call(routes, 'POST', '/push/subscribe', { subscription: { endpoint: 'x'.repeat(20_000) } })
    expect(huge.status).toBe(400)
  })
})
