// @vitest-environment node
// The service worker's cache policy is the security-critical part: it may only ever store public, content-addressed
// files. These tests evaluate the real worker source against a fake ServiceWorkerGlobalScope.
import { describe, expect, it } from 'vitest'
import { killSwitchSource, serviceWorkerSource } from '../src/host/sw-source.ts'

interface Policy {
  isCacheablePath(url: URL): boolean
  parsePayload(data: { json(): unknown } | null): { kind: string; title: string; body: string; sessionId: string }
  isStorable(request: { method: string; headers: Headers }, response: Partial<Response> & { headers: Headers }): boolean
  CACHE: string
}
type Listener = (event: any) => void // eslint-disable-line

function load(version = '9.9.9') {
  const listeners = new Map<string, Listener>()
  const self: Record<string, unknown> = {
    location: new URL('http://127.0.0.1:3090/sw.js'),
    addEventListener: (type: string, fn: Listener) => { listeners.set(type, fn) },
    skipWaiting: () => {},
    clients: { claim: async () => {} },
  }
  new Function('self', 'caches', 'fetch', 'Response', 'URL', serviceWorkerSource(version))(self, {}, async () => new Response('x'), Response, URL)
  return { policy: self['__dshPwa'] as Policy, listeners }
}
const u = (path: string) => new URL(path, 'http://127.0.0.1:3090')
const headers = (init: Record<string, string> = {}) => new Headers(init)

describe('service worker cache policy', () => {
  const { policy } = load()

  it('caches only public content-addressed files', () => {
    expect(policy.isCacheablePath(u('/assets/index-Ciz7DZxv.js'))).toBe(true)
    expect(policy.isCacheablePath(u('/assets/vendor-DV2921Zo.css'))).toBe(true)
    expect(policy.isCacheablePath(u('/plugins/??a/client.js,b/client.js&rev=0a5889a8ad32'))).toBe(true)
    expect(policy.isCacheablePath(u('/plugins/dsh-pwa/client.views.js?rev=abc123'))).toBe(true)
    expect(policy.isCacheablePath(u('/icon-192.png'))).toBe(true)
  })

  it('never caches /api, streams, sessions, share, documents or unversioned files', () => {
    for (const path of [
      '/api/session/list', '/api/remote.mux', '/api/$events/result', '/api/', '/api',
      '/plugins/events', '/plugins/dsh-sentinel/state', '/plugins/x/client.js',                 // no rev
      '/abx/state', '/abx/events', '/browser/stream', '/sidebar/api/session.phase',
      '/share', '/share?id=aaaa', '/push/key', '/push/test', '/m', '/m/app.js?v=1234567890',     // never cached
      '/', '/app', '/app.js', '/index.html', '/manifest.webmanifest', '/sw.js',
      '/assets/../api/session/list', '/assets/index.js',                                         // not hashed
    ]) expect(policy.isCacheablePath(u(path)), path).toBe(false)
    expect(policy.isCacheablePath(new URL('http://evil.example/assets/index-Ciz7DZxv.js'))).toBe(false)
  })

  it('refuses to store credentialed, private, cookie-setting or non-200 responses', () => {
    const get = { method: 'GET', headers: headers() }
    const ok = (h: Record<string, string> = {}) => ({ status: 200, type: 'basic' as ResponseType, headers: headers(h) })
    expect(policy.isStorable(get, ok())).toBe(true)
    expect(policy.isStorable(get, ok({ 'cache-control': 'public, max-age=31536000, immutable' }))).toBe(true)
    expect(policy.isStorable(get, ok({ 'set-cookie': 'a=b' }))).toBe(false)
    expect(policy.isStorable(get, ok({ 'cache-control': 'no-store' }))).toBe(false)
    expect(policy.isStorable(get, ok({ 'cache-control': 'private, max-age=60' }))).toBe(false)
    expect(policy.isStorable(get, ok({ vary: '*' }))).toBe(false)
    expect(policy.isStorable({ method: 'GET', headers: headers({ authorization: 'Bearer x' }) }, ok())).toBe(false)
    expect(policy.isStorable({ method: 'POST', headers: headers() }, ok())).toBe(false)
    expect(policy.isStorable(get, { status: 206, type: 'basic' as ResponseType, headers: headers() })).toBe(false)
    expect(policy.isStorable(get, { status: 200, type: 'opaque' as ResponseType, headers: headers() })).toBe(false)
    expect(policy.isStorable(get, { status: 200, type: 'cors' as ResponseType, headers: headers() })).toBe(false)
  })

  it('does not intercept non-cacheable requests (respondWith is never called) and ignores non-GET', () => {
    const { listeners } = load()
    const fetchHandler = listeners.get('fetch')!
    for (const [method, path, mode] of [['GET', '/api/session/list', 'cors'], ['POST', '/api/session/list', 'cors'], ['POST', '/share', 'cors'], ['GET', '/plugins/events', 'cors'], ['GET', '/sw.js', 'same-origin']] as const) {
      let responded = false
      fetchHandler({ request: { method, url: `http://127.0.0.1:3090${path}`, mode, headers: headers() }, respondWith: () => { responded = true }, waitUntil: () => {} })
      expect(responded, `${method} ${path}`).toBe(false)
    }
  })

  it('navigations are network-first with an offline page, never cached', async () => {
    const { listeners } = load()
    let response: Promise<Response> | undefined
    const failing = new Function('self', 'caches', 'fetch', 'Response', 'URL', serviceWorkerSource('1'))
    const sandbox: Record<string, unknown> = { location: new URL('http://127.0.0.1:3090/sw.js'), addEventListener: (t: string, f: Listener) => { listeners.set(t, f) }, skipWaiting: () => {}, clients: { claim: async () => {} } }
    failing(sandbox, { open: () => { throw new Error('navigations must not touch the cache') } }, async () => { throw new Error('offline') }, Response, URL)
    listeners.get('fetch')!({ request: { method: 'GET', url: 'http://127.0.0.1:3090/m', mode: 'navigate', headers: headers() }, respondWith: (p: Promise<Response>) => { response = p }, waitUntil: () => {} })
    const result = await response!
    expect(result.status).toBe(503)
    expect(result.headers.get('cache-control')).toBe('no-store')
    expect(await result.text()).toContain('offline')
  })

  it('versions its cache and removes older dsh-pwa caches on activate', async () => {
    const { listeners, policy: p } = load('2.0.0')
    expect(p.CACHE).toBe('dsh-pwa-2.0.0')
    const deleted: string[] = []
    const store = ['dsh-pwa-1.0.0', 'dsh-pwa-2.0.0', 'other-app']
    const fake = new Function('self', 'caches', 'fetch', 'Response', 'URL', serviceWorkerSource('2.0.0'))
    const sandbox: Record<string, unknown> = { location: new URL('http://127.0.0.1:3090/sw.js'), addEventListener: (t: string, f: Listener) => { listeners.set(t, f) }, skipWaiting: () => {}, clients: { claim: async () => {} } }
    fake(sandbox, { keys: async () => store, delete: async (k: string) => { deleted.push(k); return true } }, async () => new Response(''), Response, URL)
    let wait: Promise<unknown> | undefined
    listeners.get('activate')!({ waitUntil: (pr: Promise<unknown>) => { wait = pr } })
    await wait
    expect(deleted).toEqual(['dsh-pwa-1.0.0'])
  })

  it('the kill switch unregisters itself and clears only dsh-pwa caches', async () => {
    const listeners = new Map<string, Listener>()
    const deleted: string[] = []
    let unregistered = false
    const sandbox = {
      addEventListener: (t: string, f: Listener) => { listeners.set(t, f) },
      skipWaiting: () => {},
      registration: { unregister: async () => { unregistered = true } },
      clients: { matchAll: async () => [] },
    }
    new Function('self', 'caches', killSwitchSource())(sandbox, { keys: async () => ['dsh-pwa-1', 'foreign'], delete: async (k: string) => { deleted.push(k); return true } })
    let wait: Promise<unknown> | undefined
    listeners.get('activate')!({ waitUntil: (p: Promise<unknown>) => { wait = p } })
    await wait
    expect(deleted).toEqual(['dsh-pwa-1'])
    expect(unregistered).toBe(true)
  })
})

// ── Web Push in the worker ──
function loadWorker() {
  const listeners = new Map<string, Listener>()
  const shown: { title: string; options: Record<string, any> }[] = [] // eslint-disable-line
  const opened: string[] = []
  const windows: any[] = [] // eslint-disable-line
  const self: Record<string, unknown> = {
    location: new URL('http://127.0.0.1:3090/sw.js'),
    addEventListener: (type: string, fn: Listener) => { listeners.set(type, fn) },
    skipWaiting: () => {},
    clients: { claim: async () => {}, matchAll: async () => windows, openWindow: async (url: string) => { opened.push(url) } },
    registration: { showNotification: async (title: string, options: Record<string, unknown>) => { shown.push({ title, options }) } },
  }
  class FakeChannel { port1: { onmessage?: (e: { data: unknown }) => void } = {}; port2 = { postTo: (data: unknown) => { this.port1.onmessage?.({ data }) } } }
  new Function('self', 'caches', 'fetch', 'Response', 'URL', 'MessageChannel', 'setTimeout', 'clearTimeout', serviceWorkerSource('1'))(self, {}, async () => new Response('x'), Response, URL, FakeChannel, setTimeout, clearTimeout)
  const push = async (payload: unknown) => {
    let wait: Promise<unknown> | undefined
    listeners.get('push')!({ data: { json: () => payload }, waitUntil: (p: Promise<unknown>) => { wait = p } })
    await wait
  }
  const click = async (notification: { data: unknown; close(): void }) => {
    let wait: Promise<unknown> | undefined
    listeners.get('notificationclick')!({ notification, waitUntil: (p: Promise<unknown>) => { wait = p } })
    await wait
  }
  return { policy: self['__dshPwa'] as Policy, shown, opened, windows, push, click }
}
const note = { v: 1, kind: 'reply', title: 'Fix login', body: 'Done.', sessionId: 'sess-1' }

describe('service worker push', () => {
  it('shows a notification with the install icons and the session id as tag, and reads only the five payload fields', async () => {
    const w = loadWorker()
    await w.push({ ...note, evil: 'x', url: 'https://evil.example', token: 't' })
    expect(w.shown).toHaveLength(1)
    expect(w.shown[0]!.title).toBe('Fix login')
    expect(w.shown[0]!.options).toMatchObject({ body: 'Done.', icon: '/icon-192.png', badge: '/icon-192.png', tag: 'sess-1', renotify: true, data: { sessionId: 'sess-1', kind: 'reply' } })
    expect(JSON.stringify(w.shown[0])).not.toMatch(/evil|token/)
  })
  it('survives a payload that is not JSON or has a hostile session id', async () => {
    const w = loadWorker()
    expect(w.policy.parsePayload({ json: () => { throw new Error('no') } })).toMatchObject({ title: 'ohmydsh', sessionId: '' })
    expect(w.policy.parsePayload({ json: () => ({ ...note, sessionId: '../../x?y' }) }).sessionId).toBe('')
    await w.push(null)
    expect(w.shown).toHaveLength(1)
  })
  it('skips the notification when a visible, focused window already shows that session', async () => {
    const w = loadWorker()
    const answering = (sessionId: string, visible = true, focused = true) => ({ visibilityState: visible ? 'visible' : 'hidden', focused, postMessage: (_m: unknown, ports: { postTo(d: unknown): void }[]) => { ports[0]!.postTo({ sessionId }) } })
    w.windows.push(answering('sess-1'))
    await w.push(note)
    expect(w.shown).toHaveLength(0)
    w.windows.splice(0, 1, answering('other'))
    await w.push(note)
    expect(w.shown).toHaveLength(1)
    w.windows.splice(0, 1, answering('sess-1', false, true))
    await w.push(note)
    expect(w.shown).toHaveLength(2)
    w.windows.splice(0, 1, answering('sess-1', true, false))
    await w.push(note)
    expect(w.shown).toHaveLength(3)
    // the test notification is always shown
    w.windows.splice(0, 1, answering(''))
    await w.push({ ...note, kind: 'test', sessionId: '' })
    expect(w.shown).toHaveLength(4)
  })
  it('click focuses an existing window and tells it to open the session; with no window it opens /app?openSession=<id>', async () => {
    const w = loadWorker()
    const messages: unknown[] = []; let focused = 0
    w.windows.push({ focused: false, visibilityState: 'visible', focus: async () => { focused += 1 }, postMessage: (m: unknown) => { messages.push(m) } })
    let closed = 0
    await w.click({ data: { sessionId: 'sess-1' }, close: () => { closed += 1 } })
    expect(closed).toBe(1); expect(focused).toBe(1); expect(messages).toEqual([{ type: 'dsh-pwa:open-session', sessionId: 'sess-1' }]); expect(w.opened).toEqual([])
    w.windows.length = 0
    await w.click({ data: { sessionId: 'sess-1' }, close: () => {} })
    await w.click({ data: { sessionId: '' }, close: () => {} })
    expect(w.opened).toEqual(['/app?openSession=sess-1', '/app'])
  })
})

describe('service worker share target', () => {
  function shareWorker(maxShareBytes = 1024 * 1024) {
    const listeners = new Map<string, Listener>()
    const store = new Map<string, Response>()
    const cache = { put: async (k: string, r: Response) => { store.set(k, r) }, match: async (k: string | { url: string }) => store.get(typeof k === 'string' ? k : k.url)?.clone(), keys: async () => [...store.keys()].map((url) => ({ url })), delete: async (k: string | { url: string }) => store.delete(typeof k === 'string' ? k : k.url) }
    const self: Record<string, unknown> = { location: new URL('http://127.0.0.1:3090/sw.js'), addEventListener: (t: string, f: Listener) => { listeners.set(t, f) }, skipWaiting: () => {}, clients: { claim: async () => {} } }
    new Function('self', 'caches', 'fetch', 'Response', 'URL', 'crypto', serviceWorkerSource('1', { maxShareBytes }))(self, { open: async () => cache }, async () => new Response('x'), Response, URL, globalThis.crypto)
    const post = async (form: FormData, extra: { mode?: string; path?: string; headers?: Record<string, string> } = {}) => {
      const request = new Request(`http://127.0.0.1:3090${extra.path ?? '/share'}`, { method: 'POST', body: form, headers: extra.headers ?? {} })
      Object.defineProperty(request, 'mode', { value: extra.mode ?? 'navigate' })
      let answer: Promise<Response> | undefined
      listeners.get('fetch')!({ request, respondWith: (p: Promise<Response>) => { answer = p }, waitUntil: () => {} })
      return answer === undefined ? undefined : await answer
    }
    return { post, store }
  }
  const form = (fields: Record<string, string | File>) => { const f = new FormData(); for (const [k, v] of Object.entries(fields)) f.append(k, v); return f }

  it('takes the cross-site share navigation, stashes it under a random id and redirects 303 to /app?shareLocal=<id>', async () => {
    const w = shareWorker()
    const res = await w.post(form({ title: 'T', text: 'hello', files: new File(['abc'], 'a.txt', { type: 'text/plain' }) }))
    expect(res!.status).toBe(303)
    const loc = new URL(res!.headers.get('location')!)
    expect(loc.origin).toBe('http://127.0.0.1:3090'); expect(loc.pathname).toBe('/app'); expect(loc.searchParams.get('shareLocal')).toMatch(/^[a-f0-9]{24}$/)
    const id = loc.searchParams.get('shareLocal')!
    const meta = JSON.parse(await w.store.get(`http://127.0.0.1:3090/__dsh-share/${id}/meta`)!.text())
    expect(meta).toMatchObject({ title: 'T', text: 'hello', url: '', files: [{ name: 'a.txt', type: 'text/plain', size: 3 }] })
    expect(await w.store.get(`http://127.0.0.1:3090/__dsh-share/${id}/file/0`)!.text()).toBe('abc')
  })
  it('redirects to /app?shareError=1 for an empty or oversized share, and stores nothing', async () => {
    const w = shareWorker(10)
    expect(new URL((await w.post(form({ title: '', text: '' })))!.headers.get('location')!).search).toBe('?shareError=1')
    expect(new URL((await w.post(form({ files: new File(['x'.repeat(50)], 'big.bin') })))!.headers.get('location')!).search).toBe('?shareError=1')
    expect(w.store.size).toBe(0)
  })
  it('leaves /app’s own same-origin fetch to /share (not a navigation) and other POSTs to the network', async () => {
    const w = shareWorker()
    expect(await w.post(form({ text: 'x' }), { mode: 'cors' })).toBeUndefined()
    expect(await w.post(form({ text: 'x' }), { path: '/push/test' })).toBeUndefined()
  })
  it('drops stashed shares older than the TTL', async () => {
    const w = shareWorker()
    const old = 'a'.repeat(24)
    w.store.set(`http://127.0.0.1:3090/__dsh-share/${old}/meta`, new Response(JSON.stringify({ at: Date.now() - 3600_000 })))
    w.store.set(`http://127.0.0.1:3090/__dsh-share/${old}/file/0`, new Response('x'))
    await w.post(form({ text: 'fresh' }))
    expect([...w.store.keys()].some((k) => k.includes(old))).toBe(false)
    expect(w.store.size).toBe(1)
  })
})
