// @vitest-environment node
import { mkdtempSync, readFileSync, readdirSync, rmSync, existsSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { afterAll, describe, expect, it } from 'vitest'
import { readConfig } from '../src/host/config.ts'
import { buildManifest } from '../src/host/manifest.ts'
import { apply, sameOrigin } from '../src/host/index.ts'
import { ShareError, isShareId, receiveShare, safeName } from '../src/host/share.ts'

describe('config', () => {
  it('defaults and clamps; never throws', () => {
    const c = readConfig(undefined)
    expect(c.startUrl).toBe('/'); expect(c.share.maxMiB).toBe(25); expect(c.serviceWorker).toBe(true); expect(c.push.enabled).toBe(true); expect(c.push.allowInsecureEndpoints).toBe(false)
    expect(readConfig({ startUrl: 'https://evil', themeColor: 'red', share: { maxMiB: 9999 }, push: { subject: 'nope' } })).toMatchObject({ startUrl: '/', themeColor: '#ffffff', share: { maxMiB: 200 }, push: { subject: 'mailto:dsh-pwa@localhost.invalid' } })
    expect(readConfig('nonsense').name).toBe('DeepSeek Harness')
  })
  it('a leftover startUrl of the removed phone page falls back to the normal UI', () => {
    expect(readConfig({ startUrl: '/m' }).startUrl).toBe('/'); expect(readConfig({ startUrl: '/m/x' }).startUrl).toBe('/')
  })
})

describe('manifest', () => {
  const m = buildManifest(readConfig({})) as Record<string, any> // eslint-disable-line
  it('is installable: name, start_url in scope, standalone, 192 + 512 + maskable icons', () => {
    expect(m.name).toBeTruthy(); expect(m.display).toBe('standalone'); expect(m.scope).toBe('/'); expect(m.start_url).toBe('/')
    const sizes = m.icons.map((i: { sizes: string; purpose: string }) => `${i.sizes}:${i.purpose}`)
    expect(sizes).toEqual(['192x192:any', '512x512:any', '512x512:maskable'])
  })
  it('has no shortcut or URL pointing at /m', () => {
    expect(m.shortcuts).toBeUndefined()
    expect(JSON.stringify(m)).not.toMatch(/"\/m[/"]/)
  })
  it('declares a POST multipart share_target for text, url and files, and omits it when disabled', () => {
    expect(m.share_target).toMatchObject({ action: '/share', method: 'POST', enctype: 'multipart/form-data' })
    expect(m.share_target.params.files[0].name).toBe('files')
    expect(buildManifest(readConfig({ share: { enabled: false } }))['share_target']).toBeUndefined()
  })
})

describe('route table and gates', () => {
  const home = mkdtempSync(join(tmpdir(), 'pwa-home-'))
  process.env['DSH_HOME'] = home
  afterAll(() => { rmSync(home, { recursive: true, force: true }) })
  function boot(config: unknown = {}, reject: 401 | 403 | undefined = undefined) {
    const routes = new Map<string, { kind: string; handler: (req: any, res: any) => Promise<void> | void }>() // eslint-disable-line
    const injected: unknown[] = []
    const ctx = {
      effect: (fn: () => unknown) => { fn() },
      on: (_e: string, fn: (t: { push(r: unknown): void }) => void) => { fn({ push: (r) => injected.push(r) }); return () => {} },
      webServer: { register: (r: { kind: string; path: string; handler: never }) => { const key = `${r.kind} ${r.path}`; if (routes.has(key)) throw new Error('duplicate'); routes.set(key, r); return () => routes.delete(key) } },
      connection: { requestRejection: () => reject, browserPeer: {} },
      logger: () => ({ warn() {}, debug() {} }),
    }
    apply(ctx as never, config)
    return { routes, injected }
  }
  const run = async (handler: (req: any, res: any) => unknown, req: Record<string, unknown>) => { // eslint-disable-line
    const out = { status: 0, headers: {} as Record<string, string>, body: '' }
    const res = { writeHead: (s: number, h: Record<string, string>) => { out.status = s; out.headers = h ?? {} }, end: (b?: string | Buffer) => { out.body = b === undefined ? '' : String(b) } }
    await handler({ headers: { host: '127.0.0.1:3090' }, ...req }, res)
    return out
  }

  it('registers exactly the documented routes and nothing under /m', () => {
    const { routes } = boot()
    expect([...routes.keys()].sort()).toEqual(['exact /manifest.webmanifest', 'exact /push/key', 'exact /push/subscribe', 'exact /push/test', 'exact /push/unsubscribe', 'exact /share', 'exact /sw.js'])
    expect([...routes.keys()].some((k) => /\/m(\/|$)/.test(k))).toBe(false)
    expect([...boot({ push: { enabled: false } }).routes.keys()].some((k) => k.includes('/push'))).toBe(false)
  })
  it('manifest and sw.js are public GET/HEAD, cacheless, and reject other methods', async () => {
    const { routes } = boot({}, 401)
    for (const path of ['/manifest.webmanifest', '/sw.js']) {
      const r = routes.get(`exact ${path}`)!
      const get = await run(r.handler, { method: 'GET', url: path })
      expect(get.status, path).toBe(200); expect(get.headers['cache-control']).toBe('no-cache')
      expect((await run(r.handler, { method: 'POST', url: path })).status).toBe(405)
    }
    const manifest = JSON.parse((await run(routes.get('exact /manifest.webmanifest')!.handler, { method: 'GET', url: '/manifest.webmanifest' })).body)
    expect(manifest.start_url).toBe('/'); expect(manifest.display).toBe('standalone'); expect(manifest.scope).toBe('/')
  })
  it('sw.js allows root scope; serviceWorker:false serves the kill switch and injects no registration', async () => {
    const on = boot({}); const off = boot({ serviceWorker: false })
    const body = async (b: ReturnType<typeof boot>) => run(b.routes.get('exact /sw.js')!.handler, { method: 'GET', url: '/sw.js' })
    expect((await body(on)).headers['service-worker-allowed']).toBe('/')
    expect((await body(on)).body).toContain('dsh-pwa-')
    expect((await body(off)).body).toContain('unregister')
    expect(on.injected).toHaveLength(1); expect(off.injected).toHaveLength(0)
    expect((on.injected[0] as { text: string }).text).toContain('navigator.serviceWorker.register("/sw.js"')
  })
  it('/share and every /push route fail closed with 401/403 and are never public', async () => {
    for (const status of [401, 403] as const) {
      const { routes } = boot({}, status)
      expect((await run(routes.get('exact /share')!.handler, { method: 'POST', url: '/share', headers: { host: 'h', 'content-type': 'multipart/form-data; boundary=x' } })).status).toBe(status)
      expect((await run(routes.get('exact /share')!.handler, { method: 'GET', url: '/share?id=aaaaaaaaaaaaaaaaaaaaaaaa' })).status).toBe(status)
      expect((await run(routes.get('exact /push/key')!.handler, { method: 'GET', url: '/push/key' })).status).toBe(status)
      for (const path of ['/push/subscribe', '/push/unsubscribe', '/push/test']) {
        const r = await run(routes.get(`exact ${path}`)!.handler, { method: 'POST', url: path, headers: { host: '127.0.0.1:3090', origin: 'http://127.0.0.1:3090', 'content-type': 'application/json' } })
        expect(r.status, `${path} ${status}`).toBe(status)
        expect(r.body).not.toMatch(/endpoint|publicKey/)
      }
    }
  })
  it('push mutations refuse cross-origin requests even when signed in', async () => {
    const { routes } = boot({})
    for (const path of ['/push/subscribe', '/push/unsubscribe', '/push/test']) {
      for (const headers of [{ origin: 'https://evil.example' }, { 'sec-fetch-site': 'cross-site' }]) {
        const r = await run(routes.get(`exact ${path}`)!.handler, { method: 'POST', url: path, headers: { host: '127.0.0.1:3090', 'content-type': 'application/json', ...headers } })
        expect(r.status, `${path} ${JSON.stringify(headers)}`).toBe(403)
      }
    }
  })
  it('POST /share rejects cross-site requests before reading the body', async () => {
    const { routes } = boot({})
    const r = await run(routes.get('exact /share')!.handler, { method: 'POST', url: '/share', headers: { host: '127.0.0.1:3090', origin: 'https://evil.example', 'content-type': 'multipart/form-data; boundary=x' } })
    expect(r.status).toBe(403)
    expect(sameOrigin({ headers: { origin: 'http://127.0.0.1:3090', host: '127.0.0.1:3090' } } as never)).toBe(true)
    expect(sameOrigin({ headers: { host: 'h', 'sec-fetch-site': 'cross-site' } } as never)).toBe(false)
  })
})

describe('share receiver', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pwa-share-'))
  afterAll(() => { rmSync(dir, { recursive: true, force: true }) })
  function multipart(parts: { name: string; value: string; filename?: string; type?: string }[]) {
    const boundary = '----t' + Math.random().toString(16).slice(2)
    const body = parts.map((p) => `--${boundary}\r\nContent-Disposition: form-data; name="${p.name}"${p.filename ? `; filename="${p.filename}"` : ''}\r\n${p.type ? `Content-Type: ${p.type}\r\n` : ''}\r\n${p.value}\r\n`).join('') + `--${boundary}--\r\n`
    const req = Readable.from([Buffer.from(body)]) as unknown as { headers: Record<string, string> }
    req.headers = { 'content-type': `multipart/form-data; boundary=${boundary}`, 'content-length': String(Buffer.byteLength(body)) }
    return req
  }
  it('stores text, url and files under a random id; file names cannot escape', async () => {
    const rec = await receiveShare(multipart([
      { name: 'title', value: 'Hi' }, { name: 'text', value: 'Look at this' }, { name: 'url', value: 'https://example.com' },
      { name: 'files', value: 'hello', filename: '../../evil.txt', type: 'text/plain' },
      { name: 'files', value: 'again', filename: '../../evil.txt', type: 'text/plain' },
    ]) as never, { dir, cwd: '/work', maxBytes: 1 << 20 })
    expect(isShareId(rec.id)).toBe(true); expect(rec.cwd).toBe('/work'); expect(rec.text).toBe('Look at this')
    expect(rec.files).toHaveLength(2)
    for (const f of rec.files) { expect(f.path.startsWith(join(dir, rec.id) + '/')).toBe(true); expect(f.name).not.toContain('/'); expect(statSync(f.path).mode & 0o777).toBe(0o600) }
    expect(new Set(rec.files.map((f) => f.name)).size).toBe(2)
    expect(readFileSync(rec.files[0]!.path, 'utf8')).toBe('hello')
    expect(JSON.parse(readFileSync(join(dir, `${rec.id}.json`), 'utf8')).title).toBe('Hi')
  })
  it('saves files under filesDir (the workspace) while the record stays in the data dir', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'pwa-ws-'))
    const rec = await receiveShare(multipart([{ name: 'text', value: 'x' }, { name: 'files', value: 'data', filename: 'a.txt' }]) as never, { dir, cwd: workspace, maxBytes: 1 << 20, filesDir: join(workspace, '.dsh-shares') })
    expect(rec.files[0]!.path.startsWith(join(workspace, '.dsh-shares', rec.id) + '/')).toBe(true)
    expect(existsSync(join(dir, `${rec.id}.json`))).toBe(true)
    rmSync(workspace, { recursive: true, force: true })
  })
  it('rejects empty, wrong-typed and oversized shares', async () => {
    await expect(receiveShare(multipart([{ name: 'x', value: '' }]) as never, { dir, cwd: '', maxBytes: 1 << 20 })).rejects.toMatchObject({ status: 400 })
    const json = Readable.from(['{}']) as unknown as { headers: Record<string, string> }; json.headers = { 'content-type': 'application/json' }
    await expect(receiveShare(json as never, { dir, cwd: '', maxBytes: 1 << 20 })).rejects.toMatchObject({ status: 415 })
    const big = multipart([{ name: 'files', value: 'x'.repeat(5000), filename: 'a.bin' }])
    await expect(receiveShare(big as never, { dir, cwd: '', maxBytes: 1000 })).rejects.toBeInstanceOf(ShareError)
    expect(readdirSync(dir).filter((n) => n.endsWith('.json')).length).toBeGreaterThanOrEqual(1)
  })
  it('safeName strips separators and dots', () => {
    expect(safeName('../a/b\\c.txt', 'x')).toBe('c.txt'); expect(safeName('...', 'fallback')).toBe('fallback'); expect(existsSync(dir)).toBe(true)
  })
})

