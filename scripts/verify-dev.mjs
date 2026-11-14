#!/usr/bin/env node
// Live verification against the DEV harness (http://127.0.0.1:3090) with headless Chromium over CDP.
//   node scripts/verify-dev.mjs [--out .tmp] [--port 9351]
// Reads the dev launch token from the journal (never printed). Checks installability (Page.getInstallabilityErrors),
// the manifest as Chromium parsed it, service-worker registration and its cache contents, that /api and /m documents
// are never cached, a share-target round trip, and takes /m screenshots at 393x851 in light and dark.
import { spawn, execSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const args = process.argv.slice(2)
const opt = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d }
const OUT = resolve(opt('out', '.tmp')); const PORT = Number(opt('port', '9351')); const BASE = 'http://127.0.0.1:3090'
mkdirSync(OUT, { recursive: true })
const journal = execSync('journalctl --user -u dsh-dev --no-pager', { maxBuffer: 1 << 26 }).toString()
const token = [...journal.matchAll(/http:\/\/127\.0\.0\.1:3090\/\?token=([A-Za-z0-9_-]+)/g)].at(-1)?.[1]
if (!token) throw new Error('no dev launch token in the journal')
const prof = join(OUT, `cdp-profile-${PORT}`); rmSync(prof, { recursive: true, force: true })
const chrome = spawn('/usr/bin/chromium', ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${prof}`, '--no-first-run', '--disable-gpu', '--window-size=1280,900', 'about:blank'], { stdio: 'ignore' })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const results = []
const check = (name, ok, detail = '') => { results.push({ name, ok: Boolean(ok), detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`) }
try {
  await sleep(2500)
  const targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()
  const ws = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl)
  await new Promise((r) => (ws.onopen = r))
  let id = 0; const pend = new Map(); const handlers = []
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) } else handlers.forEach((h) => h(m)) }
  const send = (method, params = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })) })
  const evaluate = async (expression, awaitPromise = true) => (await send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true })).result?.result?.value
  const requests = []
  handlers.push((m) => { if (m.method === 'Network.requestWillBeSent') requests.push(m.params.request.url) })
  for (const d of ['Network', 'Page', 'Runtime', 'Emulation']) await send(`${d}.enable`)

  // 1. sign in, open the full UI, wait for the worker
  await send('Page.navigate', { url: `${BASE}/?token=${token}` }); await sleep(6000)
  const sw = await evaluate(`(async () => { const r = await navigator.serviceWorker.ready; return { scope: r.scope, state: r.active && r.active.state, script: r.active && r.active.scriptURL } })()`)
  check('service worker registers and activates', sw && sw.state === 'activated' && sw.scope === BASE + '/', JSON.stringify(sw))
  check('page is a secure context', await evaluate('window.isSecureContext', false) === true)

  // 2. installability as Chromium computes it
  const inst = await send('Page.getInstallabilityErrors')
  const errors = inst.result?.installabilityErrors ?? []
  check('Page.getInstallabilityErrors is empty', errors.length === 0, JSON.stringify(errors.map((e) => e.errorId)))
  const mf = await send('Page.getAppManifest')
  const parsed = mf.result?.data ? JSON.parse(mf.result.data) : {}
  check('manifest served is ours (start_url /m, share_target)', mf.result?.url?.endsWith('/manifest.webmanifest') && parsed.start_url === '/m' && parsed.share_target?.action === '/share', `${mf.result?.url} start_url=${parsed.start_url}`)
  check('manifest has no parse errors', (mf.result?.errors ?? []).length === 0, JSON.stringify(mf.result?.errors))
  writeFileSync(join(OUT, 'manifest-as-parsed.json'), JSON.stringify({ url: mf.result?.url, errors: mf.result?.errors, installabilityErrors: errors, manifest: parsed }, null, 2))

  // 3. what the worker cached; it must be only public static files
  await send('Page.navigate', { url: `${BASE}/` }); await sleep(5000)
  await evaluate(`fetch('/api/session/list',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({type:'client-request',rpcId:'v1',method:'session/list',payload:{args:{_request:{}}}})}).then(r=>r.text())`)
  await evaluate(`fetch('/m').then(r=>r.text())`)
  const cached = await evaluate(`(async () => { const out = {}; for (const k of await caches.keys()) out[k] = (await (await caches.open(k)).keys()).map(r => new URL(r.url).pathname + new URL(r.url).search.slice(0, 30)); return out })()`)
  const all = Object.values(cached).flat()
  check('worker cache holds only public static files', all.length > 0 && all.every((p) => /^\/(assets\/|plugins\/|m\/|icon-|apple-touch)/.test(p)) && !all.some((p) => /\/api|\/share|\/abx|\/browser|plugins\/events/.test(p)), `${all.length} entries`)
  check('/api and /m documents are not in any cache', !all.some((p) => p.startsWith('/api') || p === '/m' || p === '/m/'))
  writeFileSync(join(OUT, 'sw-cache-contents.json'), JSON.stringify(cached, null, 2))
  const controlled = await evaluate('!!navigator.serviceWorker.controller', false)
  check('page is controlled by the worker', controlled === true)

  // 4. share target round trip (fetch POST with the real multipart form the browser would send)
  const share = await evaluate(`(async () => {
    const fd = new FormData(); fd.append('title', 'Shared title'); fd.append('text', 'Check this out'); fd.append('url', 'https://example.com/x')
    fd.append('files', new File(['hello from the phone'], 'note.txt', { type: 'text/plain' }))
    const r = await fetch('/share', { method: 'POST', body: fd })
    // The 303 is followed by fetch: ending on /m?share=<id> with 200 proves both the redirect and that /m is reachable.
    const status = r.status; const redirected = r.redirected
    const id = new URL(r.url).searchParams.get('share')
    const got = id ? await (await fetch('/share?id=' + id)).json() : null
    return { status, redirected, url: new URL(r.url).pathname, id, got }
  })()`)
  check('POST /share stores the share (redirect to /m?share=<id>)', share?.id && /^[a-f0-9]{24}$/.test(share.id) && share.redirected === true && share.url === '/m' && share.status === 200, JSON.stringify({ status: share?.status, redirected: share?.redirected, url: share?.url }))
  check('GET /share?id returns text, url and the saved file', share?.got?.share?.text === 'Check this out' && share.got.share.files?.[0]?.name === 'note.txt' && share.got.share.files[0].size === 20)

  // 5. the /m page at a 393x851 phone viewport, light and dark, with touch
  for (const scheme of ['light', 'dark']) {
    await send('Emulation.setDeviceMetricsOverride', { width: 393, height: 851, deviceScaleFactor: 2, mobile: true })
    await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] })
    await send('Page.navigate', { url: `${BASE}/m` }); await sleep(3500)
    const dims = await evaluate(`({ sw: document.documentElement.scrollWidth, iw: innerWidth, rows: document.querySelectorAll('.pwa-row').length, bg: getComputedStyle(document.body).backgroundColor, tabs: document.querySelectorAll('[role=tab]').length })`, false)
    check(`/m ${scheme}: no horizontal overflow at 393px`, dims.sw <= dims.iw, JSON.stringify(dims))
    const small = await evaluate(`[...document.querySelectorAll('button,textarea')].filter(e => { const r = e.getBoundingClientRect(); return r.width && (r.height < 43.5) }).map(e => e.className + ':' + Math.round(e.getBoundingClientRect().height))`, false)
    check(`/m ${scheme}: tap targets are at least 44px`, small.length === 0, JSON.stringify(small))
    const shot = await send('Page.captureScreenshot', { format: 'png' })
    writeFileSync(join(OUT, `m-${scheme}-list.png`), Buffer.from(shot.result.data, 'base64'))
  }
  // open the first session, screenshot, and type a draft (no prompt is sent: no agent turn, no model)
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] })
  await send('Page.navigate', { url: `${BASE}/m` }); await sleep(3000)
  const opened = await evaluate(`(async () => { const row = document.querySelector('.pwa-row'); if (!row) return { rows: 0 }; row.click(); for (let i = 0; i < 40 && !document.querySelectorAll('.pwa-msg').length; i++) await new Promise(r => setTimeout(r, 250)); return { rows: 1, msgs: document.querySelectorAll('.pwa-msg').length, hash: location.hash, composer: !!document.querySelector('.pwa-composer textarea') } })()`)
  check('/m opens a session with history and a composer', opened.rows === 1 && opened.msgs > 0 && opened.composer, JSON.stringify(opened))
  // No host-injected context may appear as a chat bubble (system-reminder blocks, time samples, model-change notices).
  const leaked = await evaluate(`[...document.querySelectorAll('.pwa-msg')].map(e => e.textContent).filter(t => /<system-reminder>|Time sampled while preparing|\\[model changed:|COMPOSIO TRIGGER|The following information describes your current session/.test(t)).length`, false)
  check('/m shows no injected-context bubbles in the open session', leaked === 0, `leaked=${leaked}`)
  // Sweep the first sessions in the list too: open each one and look for leaks.
  const sweep = await evaluate(`(async () => { location.hash = '#/'; await new Promise(r => setTimeout(r, 1500)); const bad = []; const n = Math.min(8, document.querySelectorAll('.pwa-row').length); for (let i = 0; i < n; i++) { location.hash = '#/'; await new Promise(r => setTimeout(r, 500)); document.querySelectorAll('.pwa-row')[i].click(); await new Promise(r => setTimeout(r, 1500)); const t = [...document.querySelectorAll('.pwa-msg')].map(e => e.textContent).filter(t => /<system-reminder>|Time sampled while preparing|\\[model changed:|COMPOSIO TRIGGER/.test(t)); if (t.length) bad.push(i) } location.hash = '#/'; return { swept: n, bad } })()`)
  check('no session among the first 8 leaks injected context', sweep.swept >= 5 && sweep.bad.length === 0, JSON.stringify(sweep))
  const shot2 = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(join(OUT, 'm-light-session.png'), Buffer.from(shot2.result.data, 'base64'))
  // the share landing view
  await send('Page.navigate', { url: `${BASE}/m?share=${share?.id}` }); await sleep(3000)
  const sharedUi = await evaluate(`({ title: document.querySelector('.pwa-card h3')?.textContent, text: document.querySelector('.pwa-card textarea')?.value })`, false)
  check('/m?share= shows the shared text for review', sharedUi.title === 'Shared to DSH' && /Check this out/.test(sharedUi.text || ''), JSON.stringify(sharedUi))
  const shot3 = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(join(OUT, 'm-light-share.png'), Buffer.from(shot3.result.data, 'base64'))
  writeFileSync(join(OUT, 'verify-results.json'), JSON.stringify(results, null, 2))
} finally {
  chrome.kill()
}
const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
process.exit(failed.length === 0 ? 0 : 1)
