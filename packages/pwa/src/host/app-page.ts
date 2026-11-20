import { createHash } from 'node:crypto'
import { DEFAULT_PRODUCT, html, js, type Product } from './product.ts'

/**
 * The `/app` launch page and its script (`/app.js`).
 *
 * Why it exists: core sets the browser sign-in cookie `HttpOnly; SameSite=Strict`. When an installed app (Android
 * WebAPK) is opened from the launcher, Chrome treats that navigation as cross-site, so the cookie is withheld and core
 * answers `401 text/plain` for `/`. The installed app has no address bar to repair that. `/app` is public (it holds no
 * secret): the page's own same-origin `fetch` is same-site, so the cookie IS sent, and the script then either forwards
 * to `/` (a same-site navigation, cookie sent) or offers a paste-the-login-link form.
 *
 * Rules the script follows (all unit-tested): only `openSession` / `share` pass through to `/`, and only after
 * validating the values; the token is never stored (no storage API, no cache, no logging); no external resources.
 */

const STYLE = `:root{color-scheme:light dark}
body{margin:0;min-height:100vh;display:grid;place-items:center;font:16px/1.5 system-ui,sans-serif;background:Canvas;color:CanvasText}
main{box-sizing:border-box;width:100%;max-width:26rem;padding:24px}
h1{font-size:1.4rem;margin:0 0 .5rem}
p{margin:.25rem 0 1rem}
.hint{color:GrayText}
label{display:block;margin:0 0 .35rem;font-weight:600}
input,button{font:inherit;box-sizing:border-box;width:100%;padding:.65rem .75rem;border-radius:8px}
input{border:1px solid GrayText;background:Field;color:FieldText}
button{margin-top:.75rem;border:1px solid ButtonText;background:ButtonFace;color:ButtonText;font-weight:600;cursor:pointer}
.error{color:CanvasText;font-weight:600;min-height:1.5em;margin:.5rem 0 0}
[hidden]{display:none}`

/** Hash of the inline stylesheet, so the CSP can forbid every other inline style and script. */
const STYLE_HASH = `sha256-${createHash('sha256').update(STYLE).digest('base64')}`

export const APP_CSP = `default-src 'none'; script-src 'self'; style-src '${STYLE_HASH}'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`

export function appPageHtml(product: Product = DEFAULT_PRODUCT): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="referrer" content="no-referrer">
<title>${html(product.name)}</title>
<style>${STYLE}</style>
</head>
<body>
<main>
<h1 id="title">Opening ${html(product.name)}</h1>
<p id="message" class="hint">One moment.</p>
<form id="login" hidden autocomplete="off">
<label for="link">Paste your ${html(product.name)} login link</label>
<input id="link" name="link" type="text" inputmode="url" autocomplete="off" autocapitalize="none" autocorrect="off" spellcheck="false" required>
<p id="error" class="error" role="alert"></p>
<button id="submit" type="submit">Sign in</button>
</form>
<p><a id="open" href="/" hidden>Open ${html(product.name)}</a></p>
</main>
<script src="/app.js"></script>
</body>
</html>
`
}

/** Plain browser script (no inline script in the page; served from `/app.js`). */
export function appScriptSource(product: Product = DEFAULT_PRODUCT): string {
  return `'use strict'
;(function () {
  var PRODUCT = ${js(product.name)}
  var TOKEN = /^[A-Za-z0-9_-]{16,256}$/
  var ID = /^[A-Za-z0-9_-]{1,128}$/
  var LOCAL = /^[a-f0-9]{24}$/
  var SHARE_CACHE = 'dsh-share'
  var $ = function (id) { return document.getElementById(id) }
  var params = new URLSearchParams(location.search)

  /** The query string handed on to "/": only openSession and share, only with valid ids. */
  function forwarded() {
    var out = new URLSearchParams()
    var session = params.get('openSession')
    if (session !== null && ID.test(session)) out.set('openSession', session)
    var share = params.get('share')
    if (share !== null && ID.test(share)) out.set('share', share)
    var text = out.toString()
    return text === '' ? '' : '?' + text
  }

  /** A full login URL (?token=...) or a bare token. Returns '' for anything else. */
  function parseToken(input) {
    var value = String(input).trim()
    if (TOKEN.test(value)) return value
    try {
      var token = new URL(value).searchParams.get('token')
      if (token !== null && TOKEN.test(token)) return token
    } catch (e) { /* not a URL */ }
    return ''
  }

  function show(title, message) {
    $('title').textContent = title
    $('message').textContent = message
  }

  function showForm() {
    show('Sign in to ' + PRODUCT, 'Get the link from the computer running ' + PRODUCT + '.')
    var form = $('login')
    form.hidden = false
    form.addEventListener('submit', function (event) {
      event.preventDefault()
      var token = parseToken($('link').value)
      if (token === '') { $('error').textContent = 'That is not a ' + PRODUCT + ' login link. Copy the whole link again.'; return }
      $('error').textContent = ''
      signIn(token)
    })
    $('link').focus()
  }

  function showProblem(title, message) {
    $('login').hidden = true
    show(title, message)
    $('open').hidden = false
  }

  function probe() {
    // Same-origin fetch from this page: same-site, so the browser attaches the sign-in credential. Only 401 means "not signed in".
    return fetch('/push/key', { credentials: 'same-origin', cache: 'no-store' }).then(function (response) { return response.status !== 401 })
  }

  function signIn(token) {
    var pending = forwarded() !== '' || params.get('shareLocal') !== null
    if (!pending) { location.replace('/?token=' + token); return }
    // Keep the pending share / session: sign in with a fetch, then run this page again with the same query.
    fetch('/?token=' + token, { credentials: 'same-origin', cache: 'no-store', redirect: 'follow' })
      .then(function () { return probe() })
      .then(function (ok) { if (ok) location.replace('/app' + location.search); else location.replace('/?token=' + token) }, function () { location.replace('/?token=' + token) })
  }

  function localKey(id, part) { return '/__dsh-share/' + id + '/' + part }

  /** Post a share the service worker stashed (the share-sheet POST itself arrives cross-site and credential-less). */
  function deliverShare(id) {
    if (typeof caches === 'undefined') return Promise.resolve('')
    var cache
    return caches.open(SHARE_CACHE).then(function (c) {
      cache = c
      return c.match(localKey(id, 'meta'))
    }).then(function (hit) {
      if (!hit) return ''
      return hit.json().then(function (meta) {
        var form = new FormData()
        ;['title', 'text', 'url'].forEach(function (key) { if (typeof meta[key] === 'string' && meta[key] !== '') form.append(key, meta[key]) })
        var files = Array.isArray(meta.files) ? meta.files : []
        return Promise.all(files.map(function (file, index) {
          return cache.match(localKey(id, 'file/' + index)).then(function (r) { return r ? r.blob() : null })
        })).then(function (blobs) {
          blobs.forEach(function (blob, index) { if (blob) form.append('files', blob, String(files[index].name || 'shared-' + (index + 1))) })
          return fetch('/share', { method: 'POST', body: form, credentials: 'same-origin', headers: { accept: 'application/json' } })
        }).then(function (response) {
          if (!response.ok) throw new Error('share rejected')
          return response.json()
        }).then(function (body) {
          if (!body || typeof body.id !== 'string' || !/^[a-f0-9]{24}$/.test(body.id)) throw new Error('bad share answer')
          return cache.keys().then(function (keys) {
            return Promise.all(keys.filter(function (k) { return k.url.indexOf('/__dsh-share/' + id + '/') !== -1 }).map(function (k) { return cache.delete(k) }))
          }).then(function () { return body.id })
        })
      })
    })
  }

  function proceed() {
    var local = params.get('shareLocal')
    if (params.get('shareError') !== null) { showProblem('Could not share to ' + PRODUCT, 'The shared content was empty or too large. Try sharing again.'); return }
    if (local !== null && LOCAL.test(local)) {
      show('Opening ' + PRODUCT, 'Delivering your share.')
      deliverShare(local).then(function (id) {
        location.replace(id === '' ? '/' : '/?share=' + id)
      }, function () { showProblem('Could not share to ' + PRODUCT, PRODUCT + ' did not accept the shared content. Try sharing again.') })
      return
    }
    location.replace('/' + forwarded())
  }

  probe().then(function (signedIn) { if (signedIn) proceed(); else showForm() }, function () {
    showProblem('Cannot reach ' + PRODUCT, 'Check that the computer running ' + PRODUCT + ' is on and reachable, then open the app again.')
  })
})()
`
}
