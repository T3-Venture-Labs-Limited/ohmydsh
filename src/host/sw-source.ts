/**
 * Source of `/sw.js`. Kept as a string (not bundled) because it runs in the ServiceWorker global scope, and tested by
 * evaluating it against a fake scope.
 *
 * Hard rules the worker enforces:
 *  - It only answers GET requests for static, content-addressed, public files: hashed shell assets, `?rev=` plugin
 *    bundles, `?v=` /m assets and the install icons. Everything else is left to the browser (`respondWith` is never
 *    called), so `/api`, the event streams, `/share`, index/HTML documents and every plugin route are untouched.
 *  - It never stores a response that carries `Set-Cookie`, `Cache-Control: no-store|private`, or `Authorization`
 *    request credentials, and only stores 200 same-origin basic responses.
 *  - Navigations are network-first and never cached; when offline they get a built-in offline page.
 *  - Caches are versioned by the plugin; `activate` deletes every older `dsh-pwa-*` cache.
 */
export function serviceWorkerSource(version: string): string {
  return `'use strict'
// dsh-pwa service worker ${JSON.stringify(version).slice(1, -1)}
const VERSION = ${JSON.stringify(version)}
const CACHE = 'dsh-pwa-' + VERSION
const MAX_ENTRIES = 160

const OFFLINE_HTML = '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Offline</title>'
  + '<body style="font:16px system-ui;margin:0;display:grid;place-items:center;min-height:100vh;text-align:center;padding:24px">'
  + '<div><h1 style="font-size:20px">You are offline</h1><p>DSH needs a connection to your computer. This page will work again when the connection returns.</p>'
  + '<button onclick="location.reload()" style="font:inherit;padding:8px 16px">Retry</button></div></body>'

/** Public, content-addressed paths only. Keep in sync with the README. */
function isCacheablePath(url) {
  if (url.origin !== self.location.origin) return false
  const p = url.pathname
  if (/^\\/assets\\/[^/]+-[A-Za-z0-9_-]{6,}\\.(?:js|css)$/.test(p)) return true       // hashed SPA shell files
  if (p.startsWith('/plugins/') && !p.startsWith('/plugins/events') && url.searchParams.has('rev') && /\\.js(?:$|\\?)|\\/\\?\\?/.test(p + url.search)) return true // rev-pinned bundles and combos
  if (/^\\/m\\/[A-Za-z0-9_.-]+\\.(?:js|css)$/.test(p) && url.searchParams.has('v')) return true // /m assets
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

self.addEventListener('fetch', (event) => {
  const request = event.request
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
self.__dshPwa = { isCacheablePath, isStorable, CACHE, VERSION }
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
