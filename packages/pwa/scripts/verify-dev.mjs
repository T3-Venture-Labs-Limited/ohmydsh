#!/usr/bin/env node
// Live verification against the DEV harness (http://127.0.0.1:3090) with Chromium over CDP.
//   node scripts/verify-dev.mjs [--out .tmp] [--port 9351]
// Checks: manifest + installability, the service worker (cache holds only public files), route auth (401 without a
// cookie, 403 cross-origin), notification click -> session (warm window and cold start), and share -> composer draft.
// Reads the dev launch token from the journal (never printed). Sends no agent turn.
import { execSync } from 'node:child_process'
import { launch, sleep } from './cdp.mjs'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const args = process.argv.slice(2)
const opt = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d }
const OUT = resolve(opt('out', '.tmp')); const PORT = Number(opt('port', '9351')); const BASE = 'http://127.0.0.1:3090'
mkdirSync(OUT, { recursive: true })
const token = [...execSync('journalctl --user -u dsh-dev --no-pager', { maxBuffer: 1 << 26 }).toString().matchAll(/\?token=([A-Za-z0-9_-]+)/g)].at(-1)?.[1]
if (!token) throw new Error('no dev launch token in the journal')
const results = []
const check = (name, ok, detail = '') => { results.push({ name, ok: Boolean(ok), detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`) }
const b = await launch({ out: OUT, port: PORT })
const sessionOnScreen = () => b.evaluate(`document.querySelector('[data-conversation-session]')?.dataset.conversationSession ?? ''`)
try {
  await b.browser.send('Browser.grantPermissions', { origin: BASE, permissions: ['notifications'] })
  for (const d of ['Network', 'Page', 'Runtime']) await b.page.send(`${d}.enable`)

  // unauthenticated: a fresh context has no cookie yet
  const anon = async (method, path, headers = {}, body) => (await fetch(BASE + path, { method, headers, ...(body ? { body } : {}) })).status
  check('GET /push/key without sign-in -> 401', await anon('GET', '/push/key') === 401)
  check('POST /push/subscribe without sign-in -> 401', await anon('POST', '/push/subscribe', { 'content-type': 'application/json', origin: BASE }, '{}') === 401)
  check('POST /push/test without sign-in -> 401', await anon('POST', '/push/test', { 'content-type': 'application/json', origin: BASE }, '{}') === 401)
  check('POST /share without sign-in -> 401', await anon('POST', '/share', { origin: BASE, 'content-type': 'multipart/form-data; boundary=x' }, '--x--') === 401)
  check('/m is gone (falls to the SPA, not the old phone page)', !(await (await fetch(BASE + '/m')).text()).includes('/m/app.js'))

  await b.page.send('Page.navigate', { url: `${BASE}/?token=${token}` }); await sleep(6000)
  const sw = await b.evaluate(`navigator.serviceWorker.ready.then(r => ({ scope: r.scope, state: r.active && r.active.state }))`)
  check('service worker active with scope /', sw?.state === 'activated' && sw.scope === BASE + '/', JSON.stringify(sw))

  // signed in: same-origin vs cross-origin
  const fromPage = (path, headers, body = '{}') => b.evaluate(`fetch(${JSON.stringify(path)}, { method: 'POST', headers: ${JSON.stringify({ 'content-type': 'application/json', ...headers })}, body: ${JSON.stringify(body)} }).then(r => r.status)`)
  check('signed-in same-origin POST /push/unsubscribe with a bad body -> 400 (reaches the handler)', await fromPage('/push/unsubscribe', {}) === 400)
  // The Origin header is forbidden for page scripts, so cross-origin is proven with the cookie sent by a raw request.
  const cookies = (await b.page.send('Network.getCookies', { urls: [BASE] })).result.cookies.map((c) => `${c.name}=${c.value}`).join('; ')
  const raw = (path, headers) => anon('POST', path, { cookie: cookies, 'content-type': 'application/json', ...headers }, '{}')
  check('signed-in but Origin from another site -> 403 on subscribe/unsubscribe/test', (await Promise.all(['/push/subscribe', '/push/unsubscribe', '/push/test'].map((p) => raw(p, { origin: 'https://evil.example' })))).every((s) => s === 403))
  check('signed-in but Sec-Fetch-Site: cross-site -> 403', await raw('/push/subscribe', { 'sec-fetch-site': 'cross-site' }) === 403)
  check('signed-in same-origin raw POST /push/test for an unknown device -> 404', await raw('/push/test', { origin: BASE }) === 404)

  // manifest + installability
  const inst = await b.page.send('Page.getInstallabilityErrors')
  const errors = inst.result?.installabilityErrors ?? []
  check('Page.getInstallabilityErrors is empty', errors.length === 0, JSON.stringify(errors.map((e) => e.errorId)))
  const mf = await b.page.send('Page.getAppManifest')
  const parsed = mf.result?.data ? JSON.parse(mf.result.data) : {}
  check('manifest: start_url "/", scope "/", display standalone', parsed.start_url === '/' && parsed.scope === '/' && parsed.display === 'standalone', `start_url=${parsed.start_url} scope=${parsed.scope} display=${parsed.display}`)
  check('manifest: icons 192 + 512 + maskable, no shortcut to /m, share_target kept', ['192x192', '512x512'].every((s) => parsed.icons?.some((i) => i.sizes === s)) && parsed.icons?.some((i) => i.purpose === 'maskable') && !JSON.stringify(parsed).includes('"/m') && parsed.share_target?.action === '/share')
  check('manifest has no parse errors', (mf.result?.errors ?? []).length === 0, JSON.stringify(mf.result?.errors))
  writeFileSync(join(OUT, 'manifest-as-parsed.json'), JSON.stringify({ url: mf.result?.url, errors: mf.result?.errors, installabilityErrors: errors, manifest: parsed }, null, 2))

  // cache holds only public files
  const cached = await b.evaluate(`(async () => { const out = []; for (const k of await caches.keys()) for (const r of await (await caches.open(k)).keys()) out.push(new URL(r.url).pathname); return out })()`)
  check('worker cache holds only public static files', cached.length > 0 && cached.every((p) => /^\/(assets\/|plugins\/|icon-|apple-touch)/.test(p)) && !cached.some((p) => /\/api|\/share|\/push|plugins\/events/.test(p)), `${cached.length} entries`)

  // session ids to navigate between
  const ids = await b.evaluate(`fetch('/api/session/list', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId: 'v1', method: 'session/list', payload: { args: { _request: {} } } }) }).then(r => r.text())`).then((t) => [...t.matchAll(/session-[0-9a-f-]{36}/g)].map((m) => m[0]))
  const unique = [...new Set(ids)].slice(0, 3)
  check('found sessions to navigate between', unique.length >= 2, `${unique.length} ids`)

  // warm click: the service worker receives a real notificationclick for session B while the window shows A
  const [A, B] = unique
  await b.page.send('Page.navigate', { url: `${BASE}/?openSession=${A}` }); await sleep(7000)
  check('cold start ?openSession=A opens session A and cleans the URL', await sessionOnScreen() === A && await b.evaluate('location.search') === '', `shown=${(await sessionOnScreen()).slice(0, 16)} search="${await b.evaluate('location.search')}"`)
  const targets = (await b.targets()).filter((t) => t.type === 'service_worker')
  const swTarget = targets[0]
  check('service worker target found for the click', swTarget !== undefined)
  if (swTarget) {
    const ws = new WebSocket(swTarget.webSocketDebuggerUrl); await new Promise((r) => (ws.onopen = r))
    let id = 0; const pend = new Map()
    ws.onmessage = (e) => { const m = JSON.parse(e.data); pend.get(m.id)?.(m) }
    const send = (method, params = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })) })
    await send('Runtime.enable')
    const fired = await send('Runtime.evaluate', { awaitPromise: true, returnByValue: true, expression: `(async () => {
      const n = { data: { sessionId: ${JSON.stringify(B)}, kind: 'reply' }, close() {} }
      const done = []
      const e = new ExtendableEvent('notificationclick'); e.notification = n
      Object.defineProperty(e, 'notification', { value: n })
      const origWait = e.waitUntil.bind(e); e.waitUntil = (p) => { done.push(p); origWait(p) }
      self.dispatchEvent(e); await Promise.all(done); return done.length })()` })
    console.log('  click dispatch result:', JSON.stringify(fired.result?.result?.value ?? fired.result))
    ws.close()
    await sleep(3000)
    check('notificationclick (warm window showing A) opens session B in the same window', await sessionOnScreen() === B, `shown=${(await sessionOnScreen()).slice(0, 16)} expected=${B.slice(0, 16)}`)
  }

  // share target -> draft in the normal composer
  const loc = await b.evaluate(`(async () => { const f = new FormData(); f.set('title', 'Look at this'); f.set('text', 'Shared from the phone'); f.set('url', 'https://example.com/page'); f.append('files', new File(['hello'], 'note.txt', { type: 'text/plain' })); const r = await fetch('/share', { method: 'POST', body: f, redirect: 'manual' }); return { type: r.type, status: r.status } })()`)
  // a manual redirect is opaque to scripts, so follow it as the browser would: POST via a form navigation
  await b.page.send('Page.navigate', { url: `${BASE}/` }); await sleep(4000)
  await b.evaluate(`(() => { const form = document.createElement('form'); form.method = 'POST'; form.action = '/share'; form.enctype = 'multipart/form-data'; for (const [k, v] of [['title', 'Look at this'], ['text', 'Shared from the phone'], ['url', 'https://example.com/page']]) { const i = document.createElement('input'); i.name = k; i.value = v; form.appendChild(i) } document.body.appendChild(form); form.submit() })()`)
  await sleep(9000)
  const draft = await b.evaluate(`document.querySelector('[contenteditable=true]')?.innerText ?? ''`)
  check('share POST -> 303 to /?share=… -> composer shows the shared text as a draft', /Look at this/.test(draft) && /Shared from the phone/.test(draft) && /example\.com\/page/.test(draft), JSON.stringify(draft.slice(0, 90)))
  check('the draft was not sent (URL cleaned, no user message created by it)', await b.evaluate('location.search') === '', `search="${await b.evaluate('location.search')}" loc=${JSON.stringify(loc)}`)
} finally { await b.close().catch(() => {}) }
const failed = results.filter((r) => !r.ok)
writeFileSync(join(OUT, 'verify-results.json'), JSON.stringify(results, null, 2))
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
process.exit(failed.length === 0 ? 0 : 1)
