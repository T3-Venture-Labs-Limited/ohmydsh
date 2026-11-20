// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { apply, name } from '../src/index.ts'
import { iconHandler } from '../src/host/assets.ts'
import { BOOT_SCRIPT, ICON_PATHS, brandIndex, brandRows } from '../src/shared/index-html.ts'
import { GLOBAL_NAME, readConfig } from '../src/shared/config.ts'

// The stock index.html of the pinned DSH (rc.3), the shape brandIndex must handle.
const STOCK = `<!doctype html><html lang="en"><head><meta charset="utf-8" />
    <link rel="manifest" href="./manifest.webmanifest" />
    <link rel="apple-touch-icon" href="./apple-touch-icon.png" />
    <meta name="apple-mobile-web-app-title" content="DSH" />
    <link rel="icon" type="image/svg+xml" href="./favicon-dark.svg" media="(prefers-color-scheme: dark)" />
    <link rel="icon" type="image/svg+xml" href="./favicon.svg" media="(prefers-color-scheme: light)" />
    <title>DeepSeek Harness</title></head><body><div id="root"></div></body></html>`

describe('brandIndex', () => {
  const out = brandIndex(STOCK, '0.1.0')
  it('sets the tab title and the installed-app title', () => {
    expect(out).toContain('<title>ohmydsh</title>')
    expect(out).toContain('name="apple-mobile-web-app-title" content="ohmydsh"')
    expect(out).not.toMatch(/DeepSeek|DSH/)
  })
  it('keeps both favicon variants and the media queries, cache-busting the hrefs', () => {
    expect(out).toContain('href="./favicon-dark.svg?ohmydsh=0.1.0" media="(prefers-color-scheme: dark)"')
    expect(out).toContain('href="./favicon.svg?ohmydsh=0.1.0" media="(prefers-color-scheme: light)"')
    expect(out).toContain('href="./apple-touch-icon.png?ohmydsh=0.1.0"')
    expect(out).toContain('href="./manifest.webmanifest"')
  })
  it('is idempotent in effect and leaves an unknown page alone', () => {
    expect(brandIndex('<p>x</p>', '1')).toBe('<p>x</p>')
    expect(brandIndex(out, '0.1.0')).toContain('<title>ohmydsh</title>')
  })
})

describe('config and rows', () => {
  it('defaults on, honours off', () => {
    expect(readConfig(undefined)).toEqual({ enabled: true, showAttribution: true })
    expect(readConfig({ enabled: false, showAttribution: false })).toEqual({ enabled: false, showAttribution: false })
  })
  it('publishes the config global and the boot script only while enabled', () => {
    expect(brandRows(readConfig({}))).toEqual([{ kind: 'global', name: GLOBAL_NAME, value: { enabled: true, showAttribution: true } }, { kind: 'script', placement: 'head', text: BOOT_SCRIPT }])
    expect(brandRows(readConfig({ enabled: false }))).toEqual([{ kind: 'global', name: GLOBAL_NAME, value: { enabled: false, showAttribution: true } }])
    expect(BOOT_SCRIPT).not.toContain('</script')
  })
})

function fakeHost(config?: unknown) {
  const routes: { path: string }[] = []
  const taps: ((html: string) => string)[] = []
  const rows: unknown[] = []
  const handlers: Record<string, (t: { push(row: unknown): void }) => void> = {}
  const ctx = {
    effect: (fn: () => unknown) => { fn() },
    on: (event: string, fn: never) => { handlers[event] = fn },
    webServer: { register: (r: { path: string }) => { routes.push(r); return () => {} }, tapIndex: (t: (html: string) => string) => { taps.push(t); return () => {} } },
  }
  apply(ctx as never, config)
  handlers['webserver/index-inject']?.({ push: (row) => rows.push(row) })
  return { routes, taps, rows }
}

describe('host apply', () => {
  it('names itself and registers the index tap and every stock icon path', () => {
    expect(name).toBe('@t3labs/ohmydsh-brand')
    const { routes, taps, rows } = fakeHost()
    expect(routes.map((r) => r.path).sort()).toEqual([...ICON_PATHS].sort())
    expect(taps).toHaveLength(1)
    expect(taps[0]!(STOCK)).toContain('<title>ohmydsh</title>')
    expect(rows).toHaveLength(2)
  })
  it('enabled:false registers no route and no tap, but still tells the page it is off', () => {
    const { routes, taps, rows } = fakeHost({ enabled: false })
    expect(routes).toEqual([])
    expect(taps).toEqual([])
    expect(rows).toEqual([{ kind: 'global', name: GLOBAL_NAME, value: { enabled: false, showAttribution: true } }])
  })
})

function call(handler: ReturnType<typeof iconHandler>, method: string, headers: Record<string, string> = {}) {
  const out: { status: number; headers: Record<string, string>; body?: unknown } = { status: 0, headers: {} }
  const res = { writeHead: (s: number, h?: Record<string, string>) => { out.status = s; out.headers = h ?? {} }, end: (b?: unknown) => { out.body = b } }
  return handler({ method, headers } as never, res as never).then(() => out)
}

describe('icon routes', () => {
  it('serves the ohmydsh artwork, public and cacheable by validator', async () => {
    const svg = await call(iconHandler('/favicon.svg'), 'GET')
    expect(svg.status).toBe(200)
    expect(svg.headers['content-type']).toBe('image/svg+xml')
    expect(String(svg.body)).toContain('aria-label="ohmydsh"')
    const png = await call(iconHandler('/icon-192.png'), 'GET')
    expect(png.headers['content-type']).toBe('image/png')
    expect((png.body as Buffer).subarray(1, 4).toString()).toBe('PNG')
    const again = await call(iconHandler('/icon-192.png'), 'GET', { 'if-none-match': png.headers['etag']! })
    expect(again.status).toBe(304)
  })
  it('only answers GET and HEAD', async () => {
    expect((await call(iconHandler('/favicon.svg'), 'POST')).status).toBe(405)
    expect((await call(iconHandler('/favicon.svg'), 'HEAD')).body).toBeUndefined()
  })
  it('every route has a file behind it', async () => {
    for (const p of ICON_PATHS) expect((await call(iconHandler(p), 'GET')).status, p).toBe(200)
  })
})
