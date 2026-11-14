#!/usr/bin/env node
// One cheap agent turn (the dev default model, claude-haiku-5-5 at low effort) that needs an approval, answered from
// the /m page at 393x851: proves the approvals list + Allow once round trip. Creates ONE session in the dev workspace.
//   node scripts/verify-approval.mjs [--out .tmp] [--port 9352]
import { spawn, execSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const args = process.argv.slice(2)
const opt = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d }
const OUT = resolve(opt('out', '.tmp')); const PORT = Number(opt('port', '9352')); const BASE = 'http://127.0.0.1:3090'
const TARGET = join(OUT, 'pwa-approval-test.txt')
mkdirSync(OUT, { recursive: true }); rmSync(TARGET, { force: true })
const journal = execSync('journalctl --user -u dsh-dev --no-pager', { maxBuffer: 1 << 26 }).toString()
const token = [...journal.matchAll(/http:\/\/127\.0\.0\.1:3090\/\?token=([A-Za-z0-9_-]+)/g)].at(-1)?.[1]
const prof = join(OUT, `cdp-profile-${PORT}`); rmSync(prof, { recursive: true, force: true })
const chrome = spawn('/usr/bin/chromium', ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${prof}`, '--no-first-run', '--disable-gpu', 'about:blank'], { stdio: 'ignore' })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const results = []
const check = (name, ok, detail = '') => { results.push({ name, ok: Boolean(ok) }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`) }
try {
  await sleep(2500)
  const targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()
  const ws = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl)
  await new Promise((r) => (ws.onopen = r))
  let id = 0; const pend = new Map()
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) } }
  const send = (method, params = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })) })
  const ev = async (expression) => (await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result?.result?.value
  for (const d of ['Network', 'Page', 'Runtime', 'Emulation']) await send(`${d}.enable`)
  await send('Page.navigate', { url: `${BASE}/?token=${token}` }); await sleep(3000)
  await send('Emulation.setDeviceMetricsOverride', { width: 393, height: 851, deviceScaleFactor: 2, mobile: true })
  await send('Page.navigate', { url: `${BASE}/m` }); await sleep(3500)

  // 1. New session from the phone page
  const created = await ev(`(async () => { [...document.querySelectorAll('button')].find(b => b.textContent === 'New').click(); for (let i = 0; i < 40; i++) { await new Promise(r => setTimeout(r, 250)); if (location.hash.startsWith('#/s/')) return location.hash } return null })()`)
  check('New creates a session and opens it', created && created.startsWith('#/s/'), created ?? '')
  // 2. Send a prompt that needs an approval (write outside the workspace)
  const prompt = `Call the bash tool exactly once with command: echo approved-from-phone > ${TARGET}  and sandbox_permissions set to "danger-full-access" with justification "approval round-trip test". Do not run it any other way and do not retry. Then reply with only the word done.`
  await ev(`(async () => { const ta = document.querySelector('.pwa-composer textarea'); ta.value = ${JSON.stringify(prompt)}; ta.dispatchEvent(new Event('input')); [...document.querySelectorAll('.pwa-composer button')][0].click(); return true })()`)
  // 3. wait for the approval card in this session
  let card = null
  for (let i = 0; i < 90 && !card; i++) {
    await sleep(1000)
    card = await ev(`(() => { const c = document.querySelector('.pwa-msgs .pwa-card'); return c ? { title: c.querySelector('h3')?.textContent, text: c.querySelector('p')?.textContent.slice(0, 160) } : null })()`)
  }
  check('an approval card appears in the open session (pushed over /api/remote.mux, no polling)', card !== null, JSON.stringify(card))
  if (card) {
    const leaked = await ev(`[...document.querySelectorAll('.pwa-msg')].map(e => e.textContent).filter(t => /<system-reminder>|Time sampled while preparing|\\[model changed:|The following information describes your current session/.test(t)).length`)
    check('no injected-context bubble next to the approval card', leaked === 0, `leaked=${leaked}`)
    const shot = await send('Page.captureScreenshot', { format: 'png' }); writeFileSync(join(OUT, 'm-light-approval.png'), Buffer.from(shot.result.data, 'base64'))
    const tabBadge = await ev(`(async () => { location.hash = '#/'; await new Promise(r => setTimeout(r, 800)); return document.querySelector('.pwa-badge')?.textContent })()`)
    check('Approvals tab shows a badge count', Number(tabBadge) >= 1, String(tabBadge))
    await ev(`(async () => { const row = [...document.querySelectorAll('.pwa-row')][0]; row.click(); await new Promise(r => setTimeout(r, 1200)); return true })()`)
    // 4. Allow once from the phone
    await ev(`[...document.querySelectorAll('.pwa-card button')].find(b => b.textContent === 'Allow once').click()`)
    for (let i = 0; i < 60 && !existsSync(TARGET); i++) await sleep(1000)
    check('Allow once answered the approval and the tool ran', existsSync(TARGET) && readFileSync(TARGET, 'utf8').trim() === 'approved-from-phone')
    await sleep(4000)
    const gone = await ev(`!document.querySelector('.pwa-msgs .pwa-card')`)
    check('the card disappears after the answer', gone === true)
    const shot2 = await send('Page.captureScreenshot', { format: 'png' }); writeFileSync(join(OUT, 'm-light-after-approval.png'), Buffer.from(shot2.result.data, 'base64'))
  }
} finally { chrome.kill() }
rmSync(TARGET, { force: true })
const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
process.exit(failed.length === 0 ? 0 : 1)
