import { createHash } from 'node:crypto'
import { DEFAULT_PRODUCT, html, js, type Product } from './product.ts'

/**
 * `/app/pair#<code>`: the plain https fallback of the pairing QR. The code lives in the URL fragment, which browsers never
 * send to a server, so it does not reach any log. The page offers two things: open the ohmydsh app (custom scheme), or sign
 * this browser in (POST /pair/claim from this page, which sets the normal DSH cookie).
 */

const STYLE = `:root{color-scheme:light dark}
body{margin:0;min-height:100vh;display:grid;place-items:center;font:16px/1.5 system-ui,sans-serif;background:Canvas;color:CanvasText}
main{box-sizing:border-box;width:100%;max-width:26rem;padding:24px}
h1{font-size:1.4rem;margin:0 0 .5rem}
p{margin:.25rem 0 1rem}
.hint{color:GrayText}
a.button,button{display:block;box-sizing:border-box;width:100%;padding:.7rem .75rem;border-radius:8px;font:inherit;font-weight:600;text-align:center;text-decoration:none;border:1px solid ButtonText;background:ButtonFace;color:ButtonText;cursor:pointer;margin-top:.75rem}
.error{font-weight:600;min-height:1.5em}
[hidden]{display:none}`

const STYLE_HASH = `sha256-${createHash('sha256').update(STYLE).digest('base64')}`

export const PAIR_CSP = `default-src 'none'; script-src 'self'; style-src '${STYLE_HASH}'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`

export function pairPageHtml(product: Product = DEFAULT_PRODUCT): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="referrer" content="no-referrer">
<title>Pair with ${html(product.name)}</title>
<style>${STYLE}</style>
</head>
<body>
<main>
<h1 id="title">Pair this device</h1>
<p id="message" class="hint">Checking the link.</p>
<a id="open-app" class="button" href="#" hidden>Open in the ${html(product.name)} app</a>
<button id="sign-in" type="button" hidden>Sign in in this browser</button>
<p id="error" class="error" role="alert"></p>
</main>
<script src="/app/pair.js"></script>
</body>
</html>
`
}

export function pairScriptSource(product: Product = DEFAULT_PRODUCT): string {
  return `'use strict'
;(function () {
  var PRODUCT = ${js(product.name)}
  var CODE = /^[A-Za-z0-9_-]{16,64}$/
  var $ = function (id) { return document.getElementById(id) }
  var code = decodeURIComponent(location.hash.replace(/^#/, ''))
  // The code leaves the address bar and history straight away.
  try { history.replaceState(null, '', location.pathname) } catch (e) { /* ignore */ }
  if (!CODE.test(code)) {
    $('title').textContent = 'This link is not valid'
    $('message').textContent = 'Open ' + PRODUCT + ' on your computer, go to Settings > Phone app and make a new pairing link.'
    return
  }
  $('title').textContent = 'Pair this device with ' + PRODUCT
  $('message').textContent = 'Use the ' + PRODUCT + ' app if you have it, or sign in right here.'
  var app = $('open-app')
  app.href = 'ohmydsh://pair?u=' + encodeURIComponent(location.origin) + '&c=' + encodeURIComponent(code)
  app.hidden = false
  var button = $('sign-in')
  button.hidden = false
  button.addEventListener('click', function () {
    button.disabled = true
    $('error').textContent = ''
    fetch('/pair/claim', {
      method: 'POST', credentials: 'same-origin', cache: 'no-store',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: code, mode: 'cookie', deviceName: /Android/i.test(navigator.userAgent) ? 'Android browser' : /iPhone|iPad/i.test(navigator.userAgent) ? 'iOS browser' : 'Browser' })
    }).then(function (response) {
      return response.json().catch(function () { return {} }).then(function (body) {
        if (!response.ok || body.ok === false) throw new Error(body.error || 'Pairing failed (' + response.status + ').')
        location.replace('/')
      })
    }).catch(function (error) { button.disabled = false; $('error').textContent = error.message })
  })
})()
`
}
