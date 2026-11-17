#!/usr/bin/env node
// Screenshot Settings > Phone app in the dev GUI in light and dark (CDP, no agent turn). Output: --out (default .tmp)
import { spawn, execSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
const args = process.argv.slice(2)
const opt = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d }
const OUT = resolve(opt('out', '.tmp')); const PORT = Number(opt('port', '9353')); const BASE = 'http://127.0.0.1:3090'
mkdirSync(OUT, { recursive: true })
const journal = execSync('journalctl --user -u dsh-dev --no-pager', { maxBuffer: 1 << 26 }).toString()
const token = [...journal.matchAll(/http:\/\/127\.0\.0\.1:3090\/\?token=([A-Za-z0-9_-]+)/g)].at(-1)?.[1]
const prof = join(OUT, `cdp-profile-${PORT}`); rmSync(prof, { recursive: true, force: true })
const chrome = spawn('/usr/bin/chromium', ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${prof}`, '--no-first-run', '--disable-gpu', '--window-size=1280,800', 'about:blank'], { stdio: 'ignore' })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let code = 0
try {
  await sleep(2500)
  const targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()
  const ws = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl)
  await new Promise((r) => (ws.onopen = r))
  let id = 0; const pend = new Map()
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) } }
  const send = (method, params = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })) })
  const ev = async (expression) => (await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result?.result?.value
  for (const d of ['Page', 'Runtime', 'Emulation']) await send(`${d}.enable`)
  for (const scheme of ['light', 'dark']) {
    await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] })
    await send('Page.navigate', { url: `${BASE}/?token=${token}` }); await sleep(6000)
    await ev(`document.querySelector('button[aria-label="Account menu"]').click()`); await sleep(500)
    await ev(`document.querySelector('[role=menuitem]').click()`); await sleep(1500)
    const clicked = await ev(`(() => { const b = [...document.querySelectorAll('[role=dialog] button, button')].find(x => x.textContent.trim() === 'Phone app'); if (b) { b.click(); return true } return false })()`)
    await sleep(2000)
    const text = await ev(`(document.querySelector('[role=dialog]') || document.body).innerText.slice(0, 600)`)
    console.log(scheme, 'nav-clicked:', clicked, '| has page:', /Install DSH/.test(text))
    if (!clicked || !/Install DSH/.test(text)) code = 1
    writeFileSync(join(OUT, `settings-${scheme}.png`), Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).result.data, 'base64'))
  }
} finally { chrome.kill() }
process.exit(code)
