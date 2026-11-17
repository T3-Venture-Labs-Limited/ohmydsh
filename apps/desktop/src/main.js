'use strict'
// ohmydsh desktop: DeepSeek Harness with the ohmydsh plugin set, in its own window.
//   first launch  provision DSH + plugins into the app data folder (progress on the loading screen)
//   every launch  start `dsh omd` on a fixed localhost port, read the printed URL, open it in the window
//   tray          Open / Pair phone / Restart / Open log / Quit
const { app, BrowserWindow, Menu, Tray, shell, ipcMain, nativeImage, dialog, session } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const { resolvePaths } = require('./paths')
const { loadSettings, saveSettings } = require('./settings')
const { createLogger } = require('./logger')
const { provision, ProvisionError } = require('./runtime')
const { childEnv } = require('./shims')
const { Supervisor } = require('./supervisor')
const { startUpdater } = require('./updater')
const pkg = require('../package.json')

const HEADLESS_TEST = process.argv.includes('--headless-test')
const PROFILE = 'omd'

// Headless smoke test and CI: no GPU, no sandbox complaints inside containers.
if (HEADLESS_TEST) { app.disableHardwareAcceleration(); app.commandLine.appendSwitch('no-sandbox') }
if (process.env.OHMYDSH_USER_DATA) app.setPath('userData', path.resolve(process.env.OHMYDSH_USER_DATA))
app.setName('ohmydsh')

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
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false },
  })
  win.once('ready-to-show', () => { if (!settings.startMinimized || !HEADLESS_TEST) win.show() })
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

function openApp(query = '') {
  if (appUrl === undefined) return
  const w = ensureWindow()
  const target = new URL(appUrl)
  if (query) for (const [k, v] of new URLSearchParams(query)) target.searchParams.set(k, v)
  w.loadURL(target.href)
  w.show(); w.focus()
}

// ── DSH lifecycle ────────────────────────────────────────────────────────────

async function boot() {
  if (provisioning) return
  provisioning = true
  try {
    showLoading()
    await provision({ paths, electron: process.execPath, pnpmVersion: pkg.ohmydsh.pnpm, progress, log })
  } catch (e) {
    provisioning = false
    const detail = e instanceof ProvisionError ? e.message : String(e?.stack ?? e)
    fail('Could not set up DeepSeek Harness', 'Check your internet connection and try again. The first start downloads about 700 MB.', detail.split('\n').slice(-12).join('\n'))
    return
  }
  provisioning = false
  startDsh()
}

function startDsh() {
  progress({ step: 'Starting DeepSeek Harness', fraction: 1 })
  const env = childEnv({ bin: paths.bin, pnpmDir: path.dirname(paths.pnpmExe), dshHome: paths.dshHome })
  supervisor = new Supervisor({
    electron: process.execPath, dshBin: paths.dshBin, profile: PROFILE, port: settings.port, host: settings.host, trustedHosts: settings.trustedHosts, env, log,
  })
  supervisor.on('ready', ({ url }) => {
    appUrl = url
    log('DSH is ready')
    if (HEADLESS_TEST) return runHeadlessTest(url)
    openApp(pendingQuery); pendingQuery = ''
    updateTray()
  })
  supervisor.on('exit', ({ code, willRestart }) => {
    log(`DSH exited (${code}); ${willRestart ? 'restarting' : 'not restarting'}`)
    if (willRestart) { appUrl = undefined; showLoading(); progress({ step: 'DeepSeek Harness stopped, restarting…' }) }
  })
  supervisor.on('failed', (message) => fail('DeepSeek Harness keeps stopping', message, tailLog()))
  supervisor.start()
}

function tailLog() {
  try { return fs.readFileSync(logger.file, 'utf8').split('\n').slice(-14).join('\n') } catch { return '' }
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
  const origin = new URL(url).origin
  const results = []
  const check = async (name, fn) => {
    try { const detail = await fn(); results.push({ name, ok: true, detail }) } catch (e) { results.push({ name, ok: false, detail: e.message }) }
  }
  const jar = {}
  await check('token URL signs the app in (303 + HttpOnly cookie)', async () => {
    const r = await fetch(url, { redirect: 'manual' })
    const cookie = r.headers.get('set-cookie') ?? ''
    if (r.status !== 303 || !/HttpOnly/i.test(cookie)) throw new Error(`status ${r.status}`)
    jar.cookie = cookie.split(';')[0]
    return `${r.status}, ${cookie.split('=')[0].slice(0, 12)}…`
  })
  await check('the DSH web UI loads with that cookie', async () => {
    const r = await fetch(`${origin}/`, { headers: { cookie: jar.cookie } })
    const body = await r.text()
    if (r.status !== 200 || !/<html/i.test(body)) throw new Error(`status ${r.status}`)
    return `200, ${body.length} bytes of HTML`
  })
  await check('without the cookie DSH answers 401', async () => {
    const r = await fetch(`${origin}/`)
    if (r.status !== 401) throw new Error(`status ${r.status}`)
    return '401'
  })
  await check('the phone-app plugin is active (/manifest.webmanifest)', async () => {
    const r = await fetch(`${origin}/manifest.webmanifest`)
    const m = await r.json()
    if (m.start_url !== '/app') throw new Error(`start_url ${m.start_url}`)
    return `start_url ${m.start_url}`
  })
  await check('pairing routes are protected (/pair/code needs a sign-in)', async () => {
    const r = await fetch(`${origin}/pair/code`, { method: 'POST', headers: { 'content-type': 'application/json', origin }, body: '{}' })
    if (r.status !== 401) throw new Error(`status ${r.status}`)
    return '401'
  })
  const ok = results.every((r) => r.ok)
  console.log(`ohmydsh ${pkg.version} headless test (electron ${process.versions.electron}, node ${process.versions.node}, DSH home ${paths.usesOwnHome ? 'app data' : 'custom'})`)
  for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? ` – ${r.detail}` : ''}`)
  console.log(ok ? 'HEADLESS-TEST OK' : 'HEADLESS-TEST FAILED')
  finishTest(ok ? 0 : 1)
}

// ── Tray and menu ────────────────────────────────────────────────────────────

function updateTray() {
  if (!tray) return
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open ohmydsh', click: () => (appUrl ? openApp() : ensureWindow().show()) },
    { label: 'Pair phone…', enabled: appUrl !== undefined, click: pairPhone },
    { type: 'separator' },
    { label: 'Restart DeepSeek Harness', enabled: supervisor !== undefined, click: () => { appUrl = undefined; showLoading(); progress({ step: 'Restarting DeepSeek Harness…' }); supervisor.restart() } },
    { label: 'Open the log', click: () => shell.showItemInFolder(logger.file) },
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
    { label: 'Help', submenu: [{ label: 'ohmydsh on GitHub', click: () => openExternal('https://github.com/T3-Venture-Labs-Limited/ohmydsh') }, { label: 'Open the log', click: () => shell.showItemInFolder(logger.file) }] },
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
    log(`ohmydsh ${pkg.version} starting (electron ${process.versions.electron}, ${process.platform}-${process.arch}); DSH home ${paths.dshHome}`)
    // The window may only load our own DSH or the local loading page; never grant device permissions silently.
    session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => cb(['clipboard-sanitized-write', 'notifications', 'fullscreen'].includes(permission)))
    if (!HEADLESS_TEST) { setupMenu(); setupTray(); ensureWindow() }
    boot()
    if (!HEADLESS_TEST) {
      let autoUpdater
      try { autoUpdater = require('electron-updater').autoUpdater } catch { log('electron-updater not available') }
      if (autoUpdater) {
        updater = startUpdater({
          autoUpdater, platform: process.platform, packaged: app.isPackaged, env: process.env, signed: false, log, enabled: settings.autoUpdate,
          notify: (n) => { log(`update ${n.kind}: ${n.version}`); if (n.kind === 'downloaded') dialog.showMessageBox({ message: `ohmydsh ${n.version} is ready`, detail: 'It will be installed when you quit ohmydsh.', buttons: ['OK'] }) },
        })
        setTimeout(() => updater.check(), 15_000)
      }
    }
  })
}
