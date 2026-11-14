// Tiny CDP helper for the verification scripts: launches Chromium with a throwaway profile and talks to it over WebSocket.
import { spawn } from 'node:child_process'
import { mkdirSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export async function launch({ out = '.tmp', port = 9361, headless = true, args = [] } = {}) {
  const dir = resolve(out); mkdirSync(dir, { recursive: true })
  const profile = join(dir, `cdp-profile-${port}`); rmSync(profile, { recursive: true, force: true })
  const flags = [`--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--no-first-run', '--disable-gpu', '--window-size=1280,900', ...(headless ? ['--headless=new'] : []), ...args, 'about:blank']
  const chrome = spawn('/usr/bin/chromium', flags, { stdio: 'ignore' })
  for (let i = 0; i < 40; i += 1) { try { await (await fetch(`http://127.0.0.1:${port}/json/version`)).json(); break } catch { await sleep(250) } }
  const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()
  const connect = async (url) => {
    const ws = new WebSocket(url); await new Promise((r, j) => { ws.onopen = r; ws.onerror = j })
    let id = 0; const pend = new Map(); const handlers = []
    ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) } else handlers.forEach((h) => h(m)) }
    const send = (method, params = {}, sessionId) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params, ...(sessionId ? { sessionId } : {}) })) })
    return { ws, send, on: (h) => handlers.push(h) }
  }
  const browser = await connect(version.webSocketDebuggerUrl)
  const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json()
  const page = await connect(targets.find((t) => t.type === 'page').webSocketDebuggerUrl)
  const evaluate = async (expression, awaitPromise = true) => {
    const r = await page.send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true })
    if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails.text)
    return r.result?.result?.value
  }
  const close = async () => { try { await browser.send('Browser.close') } catch { /* gone */ } try { chrome.kill() } catch { /* gone */ } rmSync(profile, { recursive: true, force: true }) }
  return { browser, page, evaluate, close, port, targets: async () => (await fetch(`http://127.0.0.1:${port}/json`)).json() }
}
