'use strict'
// ohmydsh desktop: DeepSeek Harness with the ohmydsh plugin set, in its own window.
//   first launch  provision DSH + plugins into the app data folder (progress on the loading screen)
//   every launch  start `dsh omd` on a fixed localhost port, read the printed URL, open it in the window
//   tray          Open / Pair phone / Restart / Open log / Quit
const { app, BrowserWindow, Menu, Tray, shell, ipcMain, nativeImage, dialog, session, powerMonitor } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const { resolvePaths } = require('./paths')
const { loadSettings, saveSettings } = require('./settings')
const { createLogger } = require('./logger')
const { provision, ProvisionError } = require('./runtime')
const { childEnv } = require('./shims')
const { chooseNodeRuntime } = require('./node-runtime')
const { Supervisor } = require('./supervisor')
const { startUpdater } = require('./updater')
const { planOpen } = require('./app-url')
const pkg = require('../package.json')

const HEADLESS_TEST = process.argv.includes('--headless-test')
const PROFILE = 'omd'
// What runs DSH, omd, npm and the `node` shim (see node-runtime.js): OHMYDSH_NODE > the Node bundled on every OS > Electron as Node (fallback only).
// DSH's native add-on only loads under a few exact Electron builds, and on Linux sharp crashes DSH under Electron-as-Node, so a real Node runs it.
let nodeRuntime

// Headless smoke test and CI: no GPU, no sandbox complaints inside containers.
if (HEADLESS_TEST) { app.disableHardwareAcceleration(); app.commandLine.appendSwitch('no-sandbox') }
if (process.env.OHMYDSH_USER_DATA) app.setPath('userData', path.resolve(process.env.OHMYDSH_USER_DATA))
app.setName('ohmydsh')
// About box (macOS app menu, Linux): ohmydsh is the product; DeepSeek Harness is named once, as what it is built on.
app.setAboutPanelOptions({ applicationName: 'ohmydsh', applicationVersion: pkg.version, version: pkg.version, copyright: 'Built on DeepSeek Harness', website: 'https://github.com/T3-Venture-Labs-Limited/ohmydsh' })

let paths, settings, logger, supervisor, win, tray, appUrl, quitting = false, updater
let provisioning = false

const log = (line) => logger?.write(line)
const resources = () => (app.isPackaged ? process.resourcesPath : path.join(__dirname, '..', 'bundle'))
const assetPath = (name) => path.join(__dirname, 'assets', name)

function icon(size) {
  const file = path.join(__dirname, '..', 'build', process.platform === 'win32' ? 'icon.ico' : 'icon.png')
  const img = nativeImage.createFromPath(file)
  return size ? img.resize({ width: size, height: size }) : img
}
function trayIcon() {
  const name = process.platform === 'darwin' ? 'tray-template.png' : 'tray.png'
  const img = nativeImage.createFromPath(path.join(__dirname, '..', 'build', name))
  if (process.platform === 'darwin') img.setTemplateImage(true)
  return img
}

// ── Window ──────────────────────────────────────────────────────────────────

function ensureWindow() {
  if (win && !win.isDestroyed()) return win
  win = new BrowserWindow({
    width: 1280, height: 860, minWidth: 720, minHeight: 520,
    show: false, backgroundColor: '#0B0B0D', title: 'ohmydsh', icon: icon(),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false, backgroundThrottling: !HEADLESS_TEST },
  })
  win.once('ready-to-show', () => { if (!HEADLESS_TEST && !settings.startMinimized) win.show() })
  win.on('close', (e) => {
    // Closing the window keeps DSH running (agents keep working, the phone stays connected); Quit in the tray stops it.
    if (!quitting && tray) { e.preventDefault(); win.hide() }
  })
  win.webContents.setWindowOpenHandler(({ url }) => { openExternal(url); return { action: 'deny' } })
  win.webContents.on('will-navigate', (e, url) => {
    if (!isOurs(url) && !url.startsWith('file:')) { e.preventDefault(); openExternal(url) }
  })
  return win
}

function isOurs(url) {
  try { return appUrl !== undefined && new URL(url).origin === new URL(appUrl).origin } catch { return false }
}
function openExternal(url) {
  try { const u = new URL(url); if (u.protocol === 'https:' || u.protocol === 'http:' || u.protocol === 'mailto:') shell.openExternal(u.href) } catch { /* ignore */ }
}

function showLoading() {
  const w = ensureWindow()
  if (!w.webContents.getURL().startsWith('file:')) w.loadFile(path.join(__dirname, 'loading.html'))
  return w
}
function sendLoading(channel, payload) {
  const w = ensureWindow()
  const send = () => w.webContents.send(channel, payload)
  if (w.webContents.isLoading() || !w.webContents.getURL().startsWith('file:')) w.webContents.once('did-finish-load', send); else send()
}
const progress = (p) => { log(`progress: ${p.step}${p.detail ? ` – ${p.detail}` : ''}`); sendLoading('progress', p) }
function fail(title, message, tail) {
  log(`error: ${title}: ${message}`)
  showLoading(); sendLoading('error', { title, message, log: tail })
  if (HEADLESS_TEST) { console.error(`HEADLESS-TEST FAILED: ${title}: ${message}`); finishTest(1) }
}

// Is this window signed in to the DSH that runs now? (It loaded the token URL and the 303 to `./` finished.)
let signedIn = false
let openSeq = 0
/**
 * Show DSH in the window. With `query` ("settings=phone") the window ends on `<origin>/?settings=phone`:
 *   signed in already -> navigate there directly, no token anywhere;
 *   not yet           -> load the token URL (signs in; DSH's redirect drops any query), and navigate once that load has finished.
 * The token URL is only ever loaded, never left as the address after sign-in. See app-url.js.
 */
function openApp(query = '', { show = true } = {}) {
  if (appUrl === undefined) return Promise.resolve()
  const w = ensureWindow()
  const wc = w.webContents
  const plan = planOpen({ tokenUrl: appUrl, currentUrl: wc.getURL(), signedIn, query })
  if (show) { w.show(); w.focus() }
  const seq = ++openSeq
  const go = (url) => wc.loadURL(url).catch((e) => { if (e?.code !== 'ERR_ABORTED') log(`could not load the DSH page: ${e?.message ?? e}`) })
  return (async () => {
    if (plan.load !== undefined) {
      await go(plan.load)
      if (seq !== openSeq) return // a newer open superseded this one
      signedIn = isSignedIn(wc.getURL())
      if (!signedIn) log('the window did not end up signed in; the DSH page needs another try')
    }
    if (plan.then !== undefined && signedIn && seq === openSeq) await go(plan.then)
  })()
}
function isSignedIn(url) { try { const u = new URL(url); return isOurs(url) && !u.searchParams.has('token') } catch { return false } }

// ── DSH lifecycle ────────────────────────────────────────────────────────────

async function boot() {
  if (provisioning) return
  provisioning = true
  try {
    showLoading()
    log(`running DSH on ${nodeRuntime.note}`)
    await provision({ paths, electron: nodeRuntime.exe, electronAsNode: nodeRuntime.electronAsNode, pnpmVersion: pkg.ohmydsh.pnpm, progress, log })
  } catch (e) {
    provisioning = false
    const detail = e instanceof ProvisionError ? e.message : String(e?.stack ?? e)
    fail('Could not set up ohmydsh', 'Check your internet connection and try again. The first start downloads about 700 MB.', detail.split('\n').slice(-12).join('\n'))
    return
  }
  provisioning = false
  startDsh()
}

function startDsh() {
  progress({ step: 'Starting ohmydsh', fraction: 1 })
  const env = childEnv({ bin: paths.bin, pnpmDir: path.dirname(paths.pnpmExe), dshHome: paths.dshHome, electronAsNode: nodeRuntime.electronAsNode })
  supervisor = new Supervisor({
    electron: nodeRuntime.exe, dshBin: paths.dshBin, profile: PROFILE, port: settings.port, host: settings.host, trustedHosts: settings.trustedHosts, env, log,
  })
  supervisor.on('ready', ({ url }) => {
    appUrl = url
    log('DSH is ready')
    if (HEADLESS_TEST) return runHeadlessTest(url)
    const q = pendingQuery; pendingQuery = ''
    openApp(q)
    updateTray()
  })
  supervisor.on('exit', ({ code, willRestart }) => {
    log(`DSH exited (${code}); ${willRestart ? 'restarting' : 'not restarting'}`)
    if (willRestart) { appUrl = undefined; signedIn = false; showLoading(); progress({ step: 'ohmydsh stopped, restarting…' }) }
  })
  supervisor.on('failed', (message) => fail('ohmydsh keeps stopping', message, tailLog()))
  supervisor.start()
}

function tailLog() {
  try { return fs.readFileSync(logger.file, 'utf8').split('\n').slice(-14).join('\n') } catch { return '' }
}

// Update messages. Nothing here restarts the app or DSH: a downloaded update installs the next time you quit.
function showUpdateNotice(n) {
  log(`update ${n.kind}${n.version ? `: ${n.version}` : ''}${n.message ? ` (${n.message})` : ''}`)
  // The 6-hourly background checks stay quiet except for "downloaded"/"manual-available" (once per version); only a click answers with "up to date" or an error.
  const box = (message, detail, buttons = ['OK']) => dialog.showMessageBox(win && !win.isDestroyed() && win.isVisible() ? win : undefined, { message, detail, buttons, defaultId: 0 })
  if (n.kind === 'downloaded') box(`ohmydsh ${n.version} is ready`, 'It installs when you quit ohmydsh (tray → Quit). Nothing is interrupted now: running agents keep going.')
  else if (n.kind === 'available' && n.manual) box(`ohmydsh ${n.version} is downloading`, 'It installs when you quit ohmydsh.')
  else if (n.kind === 'manual-available') box(`ohmydsh ${n.version} is available`, 'This build cannot update itself yet. Download the new version from the Releases page.', ['Open the Releases page', 'Later']).then((r) => { if (r.response === 0) openExternal(n.url ?? 'https://github.com/T3-Venture-Labs-Limited/ohmydsh/releases/latest') })
  else if (n.kind === 'none') box('ohmydsh is up to date', `Version ${pkg.version}`)
  else if (n.kind === 'error') box('Could not check for updates', n.message ?? 'Try again later.')
}
async function checkForUpdates() {
  if (updater === undefined || (!updater.active && updater.reason?.startsWith('updates are turned off'))) { dialog.showMessageBox({ message: 'Updates are turned off', detail: 'Set "autoUpdate": true in settings.json (and unset OHMYDSH_NO_UPDATE).' }); return }
  await updater.check()
}

let pendingQuery = ''
function pairPhone() {
  if (appUrl === undefined) { pendingQuery = 'settings=phone'; return }
  openApp('settings=phone')
}

// ── Headless smoke test ──────────────────────────────────────────────────────
// `ohmydsh --headless-test`: provision (or reuse), start DSH, fetch the UI through the token URL, check the phone-app
// plugin answers, print a summary, exit 0/1. Nothing is shown.
let testDone = false
function finishTest(code) {
  if (testDone) return
  testDone = true
  const stop = supervisor ? supervisor.stop() : Promise.resolve()
  stop.finally(() => { logger?.close(); app.exit(code) })
}
async function runHeadlessTest(url) {
  const { runChecks, report } = require('./checks')
  const { runSharpJob } = require('./sharp-check')
  const env = childEnv({ bin: paths.bin, pnpmDir: path.dirname(paths.pnpmExe), dshHome: paths.dshHome, electronAsNode: nodeRuntime.electronAsNode })
  const { results } = await runChecks(url, { runtimeNote: nodeRuntime.kind, sharp: () => runSharpJob({ exe: nodeRuntime.exe, env, nodeModules: path.join(paths.runtime, 'node_modules') }) })
  results.push(...await runWindowChecks())
  // CI sets this: the window test must be running DSH on the bundled Node, not silently on Electron.
  if (process.env.OHMYDSH_REQUIRE_BUNDLED_NODE === '1') results.push({ name: 'DSH runs on the bundled Node', ok: nodeRuntime.kind === 'bundled', detail: nodeRuntime.note })
  const ok = results.every((r) => r.ok)
  const text = `${report(results, `ohmydsh ${pkg.version} headless test (electron ${process.versions.electron}, node ${process.versions.node}, ${process.platform}-${process.arch}, DSH home ${paths.usesOwnHome ? 'app data' : 'custom'})`)}\n${ok ? 'HEADLESS-TEST OK' : 'HEADLESS-TEST FAILED'}\n`
  console.log(text.trimEnd())
  // A GUI-subsystem exe on Windows has no console to print to: OHMYDSH_TEST_REPORT names a file the CI step reads afterwards.
  if (process.env.OHMYDSH_TEST_REPORT) { try { fs.writeFileSync(process.env.OHMYDSH_TEST_REPORT, text) } catch { /* ignore */ } }
  finishTest(ok ? 0 : 1)
}

// The real window: "Pair phone" must end on /?settings=phone without the token and open Settings > Phone app.
async function runWindowChecks() {
  const results = []
  const check = async (name, fn) => { try { results.push({ name, ok: true, detail: await fn() }) } catch (e) { results.push({ name, ok: false, detail: e.message }) } }
  const w = ensureWindow()
  const wc = w.webContents
  const seen = []
  wc.on('did-navigate', (_e, u) => seen.push(u))
  wc.on('did-navigate-in-page', (_e, u) => seen.push(u))
  const origin = new URL(appUrl).origin
  const until = async (what, fn, ms = 40_000) => {
    const end = Date.now() + ms
    for (;;) {
      let v; try { v = await fn() } catch { v = false }
      if (v) return v
      if (Date.now() > end) throw new Error(`timed out waiting for ${what}; address ${redactUrl(wc.getURL())}; page: ${await pageDigest()}`)
      await new Promise((r) => setTimeout(r, 250))
    }
  }
  const pageDigest = () => wc.executeJavaScript(`JSON.stringify({ headings: [...document.querySelectorAll('h1,h2,[role=dialog] *')].slice(0, 6).map((e) => (e.textContent || '').trim().slice(0, 30)), buttons: [...document.querySelectorAll('button')].slice(0, 14).map((b) => (b.getAttribute('aria-label') || b.textContent || '').trim().slice(0, 24)), settingsDialog: Boolean(document.querySelector('[data-shortcut-modal=settings]')), visibility: document.visibilityState, menuExpanded: (document.querySelector('button[aria-label="Account menu"]') || {}).ariaExpanded, menuItems: [...document.querySelectorAll('[role=menuitem]')].map((e) => (e.textContent || '').trim()), url: location.href })`).catch((e) => String(e))
  // A fresh app data folder shows DSH's "Preview Notice" and then "Get started" first; a person clicks Continue / Close, so the test does too.
  const phoneSectionOpen = () => wc.executeJavaScript(`(() => {
    for (const d of document.querySelectorAll('[role="dialog"][aria-modal="true"]:not([data-shortcut-modal="settings"])')) {
      const b = [...d.querySelectorAll('button')].find((x) => !x.disabled && (/^Continue/.test((x.textContent || '').trim()) || x.getAttribute('aria-label') === 'Close'))
      if (b) { b.click(); break }
    }
    const dlg = document.querySelector('[data-shortcut-modal="settings"]')
    if (!dlg) return false
    const nav = [...dlg.querySelectorAll('nav button')].find((b) => (b.textContent || '').trim() === 'Phone app')
    return Boolean(nav) && nav.getAttribute('aria-current') === 'true'
  })()`)
  const noToken = () => { if (seen.some((u) => /[?&]token=/.test(u) && !u.startsWith(appUrl.split('?')[0] + '?token='))) throw new Error('a token reached an address other than the sign-in load'); if (/[?&]token=/.test(wc.getURL())) throw new Error('the token is in the address bar') }

  await check('window, signed out: Pair phone signs in, lands on /?settings=phone without the token and opens Settings > Phone app', async () => {
    await openApp('settings=phone', { show: false })
    await until('the Phone app section', phoneSectionOpen)
    noToken()
    if (!seen.some((u) => u === `${origin}/?settings=phone`)) throw new Error(`never navigated to /?settings=phone: ${seen.map(redactUrl).join(' > ')}`)
    return `${seen.map(redactUrl).join(' > ')}; final ${redactUrl(wc.getURL())}`
  })
  await check('window, signed in: Pair phone again navigates straight to /?settings=phone (no token load)', async () => {
    await wc.loadURL(`${origin}/`)
    await until('the DSH page', () => wc.executeJavaScript('!document.querySelector("[data-shortcut-modal=settings]")'))
    seen.length = 0
    await openApp('settings=phone', { show: false })
    await until('the Phone app section', phoneSectionOpen)
    if (seen.some((u) => /token=/.test(u))) throw new Error(`the token was loaded again: ${seen.map(redactUrl).join(' > ')}`)
    if (!seen.some((u) => u === `${origin}/?settings=phone`)) throw new Error(`never navigated to /?settings=phone: ${seen.map(redactUrl).join(' > ')}`)
    return seen.map(redactUrl).join(' > ')
  })
  return results
}
const redactUrl = (u) => String(u).replace(/([?&]token=)[^&]+/g, '$1<redacted>')

// ── Tray and menu ────────────────────────────────────────────────────────────

function updateTray() {
  if (!tray) return
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open ohmydsh', click: () => (appUrl ? openApp() : ensureWindow().show()) },
    { label: 'Pair phone…', enabled: appUrl !== undefined, click: pairPhone },
    { type: 'separator' },
    { label: 'Restart ohmydsh', enabled: supervisor !== undefined, click: () => { appUrl = undefined; signedIn = false; showLoading(); progress({ step: 'Restarting ohmydsh…' }); supervisor.restart() } },
    { label: 'Open the log', click: () => shell.showItemInFolder(logger.file) },
    { label: 'Check for updates…', click: checkForUpdates },
    { label: `Version ${pkg.version}`, enabled: false },
    { type: 'separator' },
    { label: 'Quit ohmydsh', click: quit },
  ]))
}

function setupTray() {
  try { tray = new Tray(trayIcon()) } catch (e) { log(`no tray: ${e.message}`); return }
  tray.setToolTip('ohmydsh')
  tray.on('click', () => (appUrl ? openApp() : ensureWindow().show()))
  updateTray()
}

function setupMenu() {
  const mac = process.platform === 'darwin'
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(mac ? [{ role: 'appMenu' }] : []),
    { label: 'File', submenu: [{ label: 'Pair phone…', click: pairPhone }, { type: 'separator' }, mac ? { role: 'close' } : { label: 'Quit', accelerator: 'CmdOrCtrl+Q', click: quit }] },
    { role: 'editMenu' }, { role: 'viewMenu' }, { role: 'windowMenu' },
    { label: 'Help', submenu: [{ label: 'ohmydsh on GitHub', click: () => openExternal('https://github.com/T3-Venture-Labs-Limited/ohmydsh') }, { label: 'Check for updates…', click: checkForUpdates }, { label: 'Open the log', click: () => shell.showItemInFolder(logger.file) }] },
  ]))
}

async function quit() {
  if (quitting) return
  quitting = true
  log('quitting')
  try { await supervisor?.stop() } finally { logger?.close(); app.exit(0) }
}

// ── Start ────────────────────────────────────────────────────────────────────

if (!HEADLESS_TEST && !app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', (_e, argv) => {
    if (argv.includes('--pair')) pairPhone(); else if (appUrl) openApp(); else ensureWindow().show()
  })
  app.on('before-quit', (e) => { if (!quitting) { e.preventDefault(); quit() } })
  app.on('window-all-closed', () => { /* the tray keeps the app alive */ })
  app.on('activate', () => { if (appUrl) openApp(); else ensureWindow().show() })

  ipcMain.on('retry', () => { if (supervisor) { supervisor.restart() } else boot() })
  ipcMain.on('open-log', () => shell.showItemInFolder(logger.file))
  ipcMain.on('quit', quit)

  app.whenReady().then(() => {
    paths = resolvePaths({ userData: app.getPath('userData'), resources: resources(), appPath: app.getAppPath() })
    settings = loadSettings(paths.settingsFile)
    if (HEADLESS_TEST && process.env.OHMYDSH_TEST_PORT) settings = { ...settings, port: Number(process.env.OHMYDSH_TEST_PORT) }
    logger = createLogger(paths.logs)
    nodeRuntime = chooseNodeRuntime({ resources: resources(), execPath: process.execPath })
    log(`ohmydsh ${pkg.version} starting (electron ${process.versions.electron}, ${process.platform}-${process.arch}); DSH home ${paths.dshHome}`)
    // The window may only load our own DSH or the local loading page; never grant device permissions silently.
    session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => cb(['clipboard-sanitized-write', 'notifications', 'fullscreen'].includes(permission)))
    if (!HEADLESS_TEST) { setupMenu(); setupTray(); ensureWindow() }
    boot()
    if (!HEADLESS_TEST) {
      let autoUpdater
      try { autoUpdater = require('electron-updater').autoUpdater } catch { log('electron-updater not available') }
      updater = startUpdater({
        autoUpdater, platform: process.platform, packaged: app.isPackaged, env: process.env, signed: false, log, enabled: settings.autoUpdate, currentVersion: pkg.version,
        notify: showUpdateNotice,
      })
      log(updater.active ? 'updates: checked every 6 hours, installed when you quit' : `updates: ${updater.reason ?? 'off'}`)
      updater.start()
      // After the computer wakes, a check that came due while it slept runs now instead of waiting for the next timer.
      powerMonitor.on('resume', () => updater.nudge())
    }
  })
}
