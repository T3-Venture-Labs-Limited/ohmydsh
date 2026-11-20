'use strict'
// Keeping the app current. The app runs for days in the tray, so checking once at start is not enough:
//   - a check 15 s after start and then every 6 hours (and after the computer wakes from sleep, if a check is overdue);
//   - tray "Check for updates…" runs one on demand and says what it found;
//   - where the build can update itself (Linux AppImage, Windows installer) electron-updater downloads in the background and
//     installs when the app quits (autoInstallOnAppQuit). Nothing here ever calls quitAndInstall, so a running DSH turn is
//     never interrupted: the new version simply starts the next time you quit and open ohmydsh;
//   - where it cannot (macOS while unsigned, the .deb, an AppImage run from a path we cannot replace) the same schedule asks
//     GitHub's "latest release" and tells you once per version, with a link.
// An AppImage started through a symlink (~/Applications/ohmydsh.AppImage -> ohmydsh-0.1.1-linux-x86_64.AppImage): the AppImage
// runtime hands the app the REAL file in $APPIMAGE, and electron-updater replaces that file with one named after the new version.
// repointSymlinks() then moves every symlink that pointed at the old file onto the new one, so the launcher keeps working.
const fs = require('node:fs')
const path = require('node:path')

const SIX_HOURS = 6 * 60 * 60 * 1000
const FIRST_CHECK_DELAY = 15_000

function canSelfUpdate({ platform, packaged, appImage, signed }) {
  if (!packaged) return false
  if (platform === 'linux') return Boolean(appImage)
  if (platform === 'win32') return true
  return Boolean(signed) // macOS needs a signed app
}

/** Is `a` a newer version than `b`? Numeric core first; a release beats a prerelease of the same core (0.2.0 > 0.2.0-rc.1). */
function isNewer(a, b) {
  const parse = (v) => {
    const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(String(v).trim())
    return m === null ? undefined : { core: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] }
  }
  const x = parse(a); const y = parse(b)
  if (x === undefined || y === undefined) return false
  for (let i = 0; i < 3; i += 1) if (x.core[i] !== y.core[i]) return x.core[i] > y.core[i]
  if (x.pre === y.pre) return false
  if (x.pre === undefined) return true
  if (y.pre === undefined) return false
  const xs = x.pre.split('.'); const ys = y.pre.split('.')
  for (let i = 0; i < Math.max(xs.length, ys.length); i += 1) {
    if (xs[i] === undefined) return false
    if (ys[i] === undefined) return true
    const xn = /^\d+$/.test(xs[i]); const yn = /^\d+$/.test(ys[i])
    if (xn && yn && Number(xs[i]) !== Number(ys[i])) return Number(xs[i]) > Number(ys[i])
    if (xn !== yn) return !xn
    if (!xn && xs[i] !== ys[i]) return xs[i] > ys[i]
  }
  return false
}

/**
 * Runs `run(manual)` after `firstDelayMs`, then `intervalMs` after each run finished. Never two at once; `trigger(true)` runs now (a run already in progress is joined); `nudge()` runs now only when the last run is older than the interval (after the computer slept).
 * Timers and the clock are injected so the schedule is unit-tested without waiting.
 */
function createScheduler({ run, intervalMs = SIX_HOURS, firstDelayMs = FIRST_CHECK_DELAY, setTimer = setTimeout, clearTimer = clearTimeout, now = Date.now }) {
  let timer
  let inFlight
  let lastRunAt
  let stopped = true
  const arm = (ms) => {
    if (stopped) return
    if (timer !== undefined) clearTimer(timer)
    timer = setTimer(() => { timer = undefined; void trigger(false) }, ms)
    timer?.unref?.()
  }
  function trigger(manual = false) {
    if (inFlight !== undefined) return inFlight
    lastRunAt = now()
    inFlight = Promise.resolve().then(() => run(manual)).catch(() => undefined).finally(() => { inFlight = undefined; arm(intervalMs) })
    return inFlight
  }
  return {
    start() { stopped = false; arm(firstDelayMs) },
    stop() { stopped = true; if (timer !== undefined) clearTimer(timer); timer = undefined },
    trigger,
    nudge() { if (!stopped && inFlight === undefined && (lastRunAt === undefined || now() - lastRunAt >= intervalMs)) void trigger(false) },
    get running() { return inFlight !== undefined },
    get lastRunAt() { return lastRunAt },
  }
}

/** Symlinks in `dir` (and any in `extra`) that point at `oldFile`. Works after oldFile was deleted (dangling links are still read). */
function findSymlinksTo(oldFile, extra = []) {
  const found = []
  const consider = (link) => {
    try {
      if (!fs.lstatSync(link).isSymbolicLink()) return
      if (path.resolve(path.dirname(link), fs.readlinkSync(link)) === oldFile) found.push(link)
    } catch { /* not a link, or gone */ }
  }
  try { for (const name of fs.readdirSync(path.dirname(oldFile))) consider(path.join(path.dirname(oldFile), name)) } catch { /* unreadable dir */ }
  for (const link of extra) if (!found.includes(link)) consider(link)
  return found
}

/** Point every symlink that targeted `oldFile` at `newFile` (atomically: a temp link renamed over the old one). @returns {string[]} links moved */
function repointSymlinks(oldFile, newFile, extra = []) {
  const moved = []
  for (const link of findSymlinksTo(oldFile, extra)) {
    const tmp = `${link}.omd-${process.pid}`
    try {
      // Keep a relative link relative when the new file sits in the same folder.
      const target = path.isAbsolute(fs.readlinkSync(link)) ? newFile : path.relative(path.dirname(link), newFile)
      try { fs.rmSync(tmp, { force: true }) } catch { /* ignore */ }
      fs.symlinkSync(target, tmp)
      fs.renameSync(tmp, link)
      moved.push(link)
    } catch { try { fs.rmSync(tmp, { force: true }) } catch { /* ignore */ } }
  }
  return moved
}

/**
 * @param {object} o
 * @param {object} o.autoUpdater       electron-updater's autoUpdater
 * @param {string} o.platform
 * @param {boolean} o.packaged
 * @param {NodeJS.ProcessEnv} o.env
 * @param {boolean} o.signed
 * @param {(line: string) => void} o.log
 * @param {(n: { kind: string, version?: string, url?: string, manual?: boolean, message?: string }) => void} o.notify
 *   kinds: available, downloaded, none, manual-available, error, disabled, unsupported
 * @param {boolean} o.enabled
 * @param {string} [o.currentVersion]  needed for the GitHub fallback
 * @param {typeof fetch} [o.fetchImpl]
 * @param {object} [o.timing]          passed to createScheduler (tests)
 * @param {typeof repointSymlinks} [o.repoint]
 */
function startUpdater({ autoUpdater, platform, packaged, env, signed, log, notify, enabled, currentVersion, fetchImpl, timing = {}, repoint = repointSymlinks }) {
  const announced = new Set()
  const tell = (n) => {
    // One notification per version and kind; a manual check always answers.
    const key = `${n.kind}:${n.version ?? ''}`
    if (!n.manual && announced.has(key)) return
    announced.add(key)
    notify(n)
  }
  const idle = { active: false, check: async () => ({ status: 'disabled' }), start() {}, stop() {}, nudge() {} }
  if (!enabled || env.OHMYDSH_NO_UPDATE === '1') return { ...idle, reason: 'updates are turned off (settings.json autoUpdate / OHMYDSH_NO_UPDATE)' }
  const self = canSelfUpdate({ platform, packaged, appImage: env.APPIMAGE, signed })

  let run
  if (self) {
    autoUpdater.autoDownload = true            // fetch the update in the background
    autoUpdater.autoInstallOnAppQuit = true    // ... and install it when the app quits; never quitAndInstall (would stop a running turn)
    autoUpdater.logger = { info: (m) => log(`updater: ${m}`), warn: (m) => log(`updater: ${m}`), error: (m) => log(`updater: ${m}`), debug: () => {} }
    let manualPending = false
    autoUpdater.on('update-available', (i) => tell({ kind: 'available', version: i.version, manual: manualPending }))
    autoUpdater.on('update-downloaded', (i) => tell({ kind: 'downloaded', version: i.version, manual: manualPending }))
    autoUpdater.on('error', (e) => log(`updater error: ${e?.message ?? e}`))
    // electron-updater replaces the AppImage file with one named after the new version; keep symlinks to it working.
    autoUpdater.on('appimage-filename-updated', (file) => {
      const old = env.APPIMAGE
      if (!old || path.resolve(file) === path.resolve(old)) return
      const extra = (env.OHMYDSH_APPIMAGE_LINKS ?? '').split(path.delimiter).filter(Boolean)
      const moved = repoint(path.resolve(old), path.resolve(file), extra)
      log(`updater: AppImage is now ${file}${moved.length ? `; moved ${moved.length} symlink(s): ${moved.join(', ')}` : ''}`)
    })
    run = async (manual) => {
      manualPending = manual
      try {
        const r = await autoUpdater.checkForUpdates()
        if (!r) return { status: 'unsupported' }
        if (!r.isUpdateAvailable) { if (manual) tell({ kind: 'none', manual }); return { status: 'none' } }
        return { status: 'available', version: r.updateInfo?.version }
      } catch (e) {
        log(`updater: ${e.message}`)
        if (manual) tell({ kind: 'error', manual, message: e.message })
        return { status: 'error', message: e.message }
      } finally { manualPending = false }
    }
  } else {
    // Cannot replace ourselves: say that a newer release exists, once per version.
    const doFetch = fetchImpl ?? globalThis.fetch
    run = async (manual) => {
      try {
        const r = await doFetch('https://api.github.com/repos/T3-Venture-Labs-Limited/ohmydsh/releases/latest', { headers: { accept: 'application/vnd.github+json', 'user-agent': 'ohmydsh-desktop' } })
        if (!r.ok) throw new Error(`GitHub answered ${r.status}`)
        const rel = await r.json()
        const version = String(rel.tag_name ?? '').replace(/^v/, '')
        if (currentVersion !== undefined && isNewer(version, currentVersion)) { tell({ kind: 'manual-available', version, url: rel.html_url, manual }); return { status: 'available', version } }
        if (manual) tell({ kind: 'none', manual })
        return { status: 'none' }
      } catch (e) {
        log(`updater: ${e.message}`)
        if (manual) tell({ kind: 'error', manual, message: e.message })
        return { status: 'error', message: e.message }
      }
    }
  }

  const scheduler = createScheduler({ run, ...timing })
  return {
    active: self,
    reason: self ? undefined : 'self-update is not available for this build; the app only tells you about new releases',
    start: () => scheduler.start(),
    stop: () => scheduler.stop(),
    nudge: () => scheduler.nudge(),
    /** Tray "Check for updates…": check now and report; shares the run in progress if there is one. */
    check: async () => { if (scheduler.running) await scheduler.trigger(false); return scheduler.trigger(true) },
    scheduler,
  }
}

module.exports = { startUpdater, canSelfUpdate, createScheduler, isNewer, repointSymlinks, findSymlinksTo, SIX_HOURS }
