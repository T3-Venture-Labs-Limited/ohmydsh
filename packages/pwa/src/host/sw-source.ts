import { DEFAULT_PRODUCT, js, type Product } from './product.ts'

/**
 * Source of `/sw.js`. Kept as a string (not bundled) because it runs in the ServiceWorker global scope, and tested by
 * evaluating it against a fake scope.
 *
 * Hard rules the worker enforces:
 *  - It only answers GET requests for static, content-addressed, public files: hashed shell assets, `?rev=` plugin
 *    bundles and the install icons. Everything else is left to the browser (`respondWith` is never
 *    called), so `/api`, the event streams, `/share`, `/push`, index/HTML documents and every plugin route are untouched.
 *  - It never stores a response that carries `Set-Cookie`, `Cache-Control: no-store|private`, or `Authorization`
 *    request credentials, and only stores 200 same-origin basic responses.
 *  - Navigations are network-first and never cached; when offline they get a built-in offline page.
 *  - Caches are versioned by the plugin; `activate` deletes every older `dsh-pwa-*` cache.
 *  - `push`: the payload is `{ v, kind, title, body, sessionId }` and nothing else. A notification is shown unless a
 *    visible, focused window already shows that session (asked over a MessageChannel; the client plugin answers).
 *    `notificationclick` focuses an existing window and tells it to open the session, or opens `/app?openSession=<id>`
 *    (never `/` directly: that launch is cross-site and would not carry the Strict sign-in cookie).
 *  - `POST /share` is answered by the worker (see the share target section), which stashes it and redirects to /app.
 */
export function serviceWorkerSource(version: string, options: { maxShareBytes?: number; product?: Product } = {}): string {
  const product = options.product ?? DEFAULT_PRODUCT
  const maxShareBytes = Math.max(1, Math.floor(options.maxShareBytes ?? 25 * 1024 * 1024))
  return `'use strict'
// dsh-pwa service worker ${JSON.stringify(version).slice(1, -1)}
const VERSION = ${JSON.stringify(version)}
const CACHE = 'dsh-pwa-' + VERSION
const MAX_ENTRIES = 160
const SHARE_CACHE = 'dsh-share'
const SHARE_TTL_MS = 10 * 60 * 1000
const MAX_SHARE_BYTES = ${maxShareBytes}

const PRODUCT = ${js(product.name)}
const OFFLINE_HTML = '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Offline</title>'
  + '<body style="font:16px system-ui;margin:0;display:grid;place-items:center;min-height:100vh;text-align:center;padding:24px">'
  + '<div><h1 style="font-size:20px">You are offline</h1><p>' + PRODUCT.replace(/[&<>]/g, '') + ' needs a connection to your computer. This page will work again when the connection returns.</p>'
  + '<button onclick="location.reload()" style="font:inherit;padding:8px 16px">Retry</button></div></body>'

/** Public, content-addressed paths only. Keep in sync with the README. */
function isCacheablePath(url) {
  if (url.origin !== self.location.origin) return false
  const p = url.pathname
  if (/^\\/assets\\/[^/]+-[A-Za-z0-9_-]{6,}\\.(?:js|css)$/.test(p)) return true       // hashed SPA shell files
  if (p.startsWith('/plugins/') && !p.startsWith('/plugins/events') && url.searchParams.has('rev') && /\\.js(?:$|\\?)|\\/\\?\\?/.test(p + url.search)) return true // rev-pinned bundles and combos
  if (/^\\/(?:icon-192|icon-512|icon-maskable-512|apple-touch-icon)\\.png$/.test(p)) return true
  return false
}

function isStorable(request, response) {
  if (request.method !== 'GET') return false
  if (request.headers.has('authorization')) return false
  if (!response || response.status !== 200 || response.type !== 'basic') return false
  if (response.headers.has('set-cookie')) return false
  const cc = (response.headers.get('cache-control') || '').toLowerCase()
  if (cc.includes('no-store') || cc.includes('private')) return false
  if (response.headers.has('vary') && response.headers.get('vary').includes('*')) return false
  return true
}

async function trim(cache) {
  const keys = await cache.keys()
  for (let i = 0; i < keys.length - MAX_ENTRIES; i += 1) await cache.delete(keys[i])
}

async function cacheFirst(event) {
  const cache = await caches.open(CACHE)
  const hit = await cache.match(event.request)
  if (hit) return hit
  const response = await fetch(event.request)
  if (isStorable(event.request, response)) {
    const copy = response.clone()
    event.waitUntil(cache.put(event.request, copy).then(() => trim(cache)))
  }
  return response
}

self.addEventListener('install', () => { self.skipWaiting() })

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key.startsWith('dsh-pwa-') && key !== CACHE) await caches.delete(key)
    await self.clients.claim()
  })())
})

// ── Web Push ──
const KINDS = ['approval', 'question', 'plan', 'reply', 'test']
function clean(value, max) { return typeof value === 'string' ? value.slice(0, max) : '' }

/** Only the five documented fields are read; anything else in a payload is ignored. */
function parsePayload(data) {
  let raw
  try { raw = data ? data.json() : null } catch (e) { raw = null }
  if (!raw || typeof raw !== 'object') return { kind: 'reply', title: PRODUCT, body: '', sessionId: '' }
  return {
    kind: KINDS.includes(raw.kind) ? raw.kind : 'reply',
    title: clean(raw.title, 120) || PRODUCT,
    body: clean(raw.body, 240),
    sessionId: /^[A-Za-z0-9_-]{1,80}$/.test(clean(raw.sessionId, 80)) ? raw.sessionId : '',
  }
}

/** Ask one window which session it shows. Resolves to '' when it does not answer in time. */
function askSession(client) {
  return new Promise((resolve) => {
    const channel = new MessageChannel()
    const timer = setTimeout(() => resolve(''), 500)
    channel.port1.onmessage = (event) => { clearTimeout(timer); resolve(event.data && typeof event.data.sessionId === 'string' ? event.data.sessionId : '') }
    try { client.postMessage({ type: 'dsh-pwa:current-session' }, [channel.port2]) } catch (e) { clearTimeout(timer); resolve('') }
  })
}

async function sessionIsOnScreen(sessionId) {
  if (!sessionId) return false
  const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
  for (const client of windows) {
    if (client.visibilityState !== 'visible' || !client.focused) continue
    if (await askSession(client) === sessionId) return true
  }
  return false
}

self.addEventListener('push', (event) => {
  const note = parsePayload(event.data)
  event.waitUntil((async () => {
    if (note.kind !== 'test' && await sessionIsOnScreen(note.sessionId)) return
    await self.registration.showNotification(note.title, {
      body: note.body,
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      // One notification per session: a newer one replaces the older one instead of stacking.
      tag: note.sessionId || 'dsh-pwa-' + note.kind,
      renotify: true,
      data: { sessionId: note.sessionId, kind: note.kind },
    })
  })())
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const sessionId = event.notification.data && event.notification.data.sessionId || ''
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    const target = windows.find((c) => c.focused) || windows.find((c) => c.visibilityState === 'visible') || windows[0]
    if (target) {
      try { await target.focus() } catch (e) { /* not allowed: still tell it */ }
      if (sessionId) target.postMessage({ type: 'dsh-pwa:open-session', sessionId })
      return
    }
    // Always through /app: a launch from a notification is cross-site, so the Strict sign-in cookie is withheld from a direct "/" request.
    await self.clients.openWindow(sessionId ? '/app?openSession=' + encodeURIComponent(sessionId) : '/app')
  })())
})

// ── Share target ──
// The share sheet POSTs to /share as a cross-site navigation, so the Strict sign-in cookie is not sent and the server
// would answer 401. The worker takes the POST instead, stashes it in Cache Storage under a random id (short TTL) and
// redirects to /app?shareLocal=<id>; /app then posts it to /share from a same-origin fetch, where the cookie is sent.
function randomId() {
  const bytes = new Uint8Array(12)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

async function pruneShares(cache) {
  const now = Date.now()
  for (const key of await cache.keys()) {
    if (!key.url.endsWith('/meta')) continue
    const hit = await cache.match(key)
    let at = 0
    try { at = (await hit.json()).at || 0 } catch (e) { at = 0 }
    if (now - at > SHARE_TTL_MS) {
      const prefix = key.url.slice(0, -'meta'.length)
      for (const other of await cache.keys()) if (other.url.startsWith(prefix)) await cache.delete(other)
    }
  }
}

async function stashShare(request) {
  const redirect = (query) => Response.redirect(self.location.origin + '/app?' + query, 303)
  try {
    const declared = Number(request.headers.get('content-length') || '0')
    if (declared > MAX_SHARE_BYTES) return redirect('shareError=1')
    const form = await request.formData()
    const field = (name) => { const v = form.get(name); return typeof v === 'string' ? v.slice(0, 20000) : '' }
    const files = form.getAll('files').filter((v) => typeof v !== 'string').slice(0, 12)
    const total = files.reduce((n, f) => n + f.size, 0)
    const meta = { at: Date.now(), title: field('title'), text: field('text'), url: field('url'), files: files.map((f) => ({ name: f.name, type: f.type, size: f.size })) }
    if (total > MAX_SHARE_BYTES || (meta.title === '' && meta.text === '' && meta.url === '' && files.length === 0)) return redirect('shareError=1')
    const cache = await caches.open(SHARE_CACHE)
    await pruneShares(cache)
    const id = randomId()
    const base = self.location.origin + '/__dsh-share/' + id + '/'
    for (const [index, file] of files.entries()) await cache.put(base + 'file/' + index, new Response(file, { headers: { 'content-type': file.type || 'application/octet-stream' } }))
    await cache.put(base + 'meta', new Response(JSON.stringify(meta), { headers: { 'content-type': 'application/json' } }))
    return redirect('shareLocal=' + id)
  } catch (e) {
    return redirect('shareError=1')
  }
}

self.addEventListener('fetch', (event) => {
  const request = event.request
  if (request.method === 'POST') {
    const target = new URL(request.url)
    // Only the share sheet's navigation: /app's own same-origin fetch to /share (JSON) must reach the server.
    if (request.mode === 'navigate' && target.origin === self.location.origin && target.pathname === '/share') event.respondWith(stashShare(request))
    return
  }
  if (request.method !== 'GET') return
  const url = new URL(request.url)
  if (request.mode === 'navigate') {
    // Network-first, never stored: documents can carry the signed-in state.
    event.respondWith(fetch(request).catch(() => new Response(OFFLINE_HTML, { status: 503, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } })))
    return
  }
  if (!isCacheablePath(url)) return
  event.respondWith(cacheFirst(event))
})

// Test hooks (no effect in a browser): expose the policy for unit tests.
self.__dshPwa = { isCacheablePath, isStorable, parsePayload, stashShare, CACHE, VERSION }
`
}

/** Replacement script served when `serviceWorker: false` or the plugin is being removed: unregisters itself and clears its caches. */
export function killSwitchSource(): string {
  return `'use strict'
self.addEventListener('install', () => { self.skipWaiting() })
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key.startsWith('dsh-pwa-')) await caches.delete(key)
    await self.registration.unregister()
    const clients = await self.clients.matchAll({ type: 'window' })
    for (const client of clients) client.navigate(client.url)
  })())
})
`
}
