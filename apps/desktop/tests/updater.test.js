'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { canSelfUpdate, startUpdater } = require('../src/updater')

test('self-update rules per platform', () => {
  assert.equal(canSelfUpdate({ platform: 'linux', packaged: true, appImage: '/x.AppImage' }), true)
  assert.equal(canSelfUpdate({ platform: 'linux', packaged: true }), false) // .deb is updated by re-installing
  assert.equal(canSelfUpdate({ platform: 'win32', packaged: true }), true)
  assert.equal(canSelfUpdate({ platform: 'darwin', packaged: true, signed: false }), false) // unsigned macOS apps cannot apply updates
  assert.equal(canSelfUpdate({ platform: 'darwin', packaged: true, signed: true }), true)
  assert.equal(canSelfUpdate({ platform: 'linux', packaged: false, appImage: '/x' }), false)
})
test('disabled by setting or env; otherwise wires events and checks', async () => {
  const au = Object.assign(new (require('node:events').EventEmitter)(), { checks: 0, checkForUpdates() { this.checks += 1; return Promise.resolve() } })
  assert.equal(startUpdater({ autoUpdater: au, platform: 'win32', packaged: true, env: {}, log() {}, notify() {}, enabled: false }).active, false)
  assert.equal(startUpdater({ autoUpdater: au, platform: 'win32', packaged: true, env: { OHMYDSH_NO_UPDATE: '1' }, log() {}, notify() {}, enabled: true }).active, false)
  const seen = []; const u = startUpdater({ autoUpdater: au, platform: 'win32', packaged: true, env: {}, log() {}, notify: (n) => seen.push(n), enabled: true })
  assert.equal(u.active, true); await u.check(); assert.equal(au.checks, 1)
  au.emit('update-downloaded', { version: '0.2.0' }); assert.deepEqual(seen, [{ kind: 'downloaded', version: '0.2.0', manual: false }])
})

const { EventEmitter } = require('node:events')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createScheduler, isNewer, repointSymlinks, SIX_HOURS } = require('../src/updater')

function fakeClock() {
  let t = 0; const timers = new Set()
  return {
    now: () => t, timers, jump(ms) { t += ms },
    setTimer: (fn, ms) => { const h = { fn, at: t + ms, unref() {} }; timers.add(h); return h },
    clearTimer: (h) => timers.delete(h),
    async advance(ms) { // run timers due within ms, in order, letting promises settle between them
      const end = t + ms
      for (;;) {
        const next = [...timers].filter((h) => h.at <= end).sort((a, b) => a.at - b.at)[0]
        if (!next) break
        timers.delete(next); t = next.at; next.fn(); await new Promise((r) => setImmediate(r))
      }
      t = end
    },
  }
}

test('schedule: first check after 15 s, then every 6 hours, never two at once', async () => {
  const c = fakeClock(); let runs = 0; let release
  const s = createScheduler({ run: () => { runs += 1; return new Promise((r) => { release = r }) }, setTimer: c.setTimer, clearTimer: c.clearTimer, now: c.now })
  s.start()
  await c.advance(14_000); assert.equal(runs, 0)
  await c.advance(2_000); assert.equal(runs, 1); assert.equal(s.running, true)
  const joined = s.trigger(); assert.equal(runs, 1) // a manual trigger joins the run in progress instead of starting another
  release(); await joined; assert.equal(s.running, false)
  await c.advance(SIX_HOURS - 1_000); assert.equal(runs, 1)
  await c.advance(2_000); assert.equal(runs, 2)
})
test('schedule: interval counts from the end of a check; trigger and nudge', async () => {
  const c = fakeClock(); let runs = 0; const manual = []
  const s = createScheduler({ run: async (m) => { runs += 1; manual.push(m) }, setTimer: c.setTimer, clearTimer: c.clearTimer, now: c.now })
  s.start(); await c.advance(15_000); assert.equal(runs, 1)
  await c.advance(SIX_HOURS - 1_000); assert.equal(runs, 1)
  await c.advance(2_000); assert.equal(runs, 2)
  await c.advance(SIX_HOURS); assert.equal(runs, 3)
  await s.trigger(true); assert.equal(runs, 4); assert.deepEqual(manual.slice(-1), [true])
  s.nudge(); await new Promise((r) => setImmediate(r)); assert.equal(runs, 4) // checked a moment ago: a wake-up does not repeat it
  await c.advance(SIX_HOURS - 10); s.nudge() // still fine, timer will fire
  s.stop(); await c.advance(SIX_HOURS * 3); assert.equal(runs, 4) // stopped: no more checks
})
test('schedule: nudge after a long sleep runs an overdue check at once; a failing check does not stop the schedule', async () => {
  const c = fakeClock(); let runs = 0
  const s = createScheduler({ run: async () => { runs += 1; throw new Error('offline') }, setTimer: c.setTimer, clearTimer: c.clearTimer, now: c.now })
  s.start(); await c.advance(15_000); assert.equal(runs, 1)
  // the computer slept: the clock jumped but timers did not fire
  c.jump(SIX_HOURS + 5); s.nudge(); await new Promise((r) => setImmediate(r)); assert.equal(runs, 2)
})
test('self-updating builds: background download, install on quit, no forced restart; manual check reports "up to date"', async () => {
  const au = Object.assign(new EventEmitter(), { r: { isUpdateAvailable: false }, checkForUpdates() { return Promise.resolve(this.r) } })
  const seen = []
  const c = fakeClock()
  const u = startUpdater({ autoUpdater: au, platform: 'linux', packaged: true, env: { APPIMAGE: '/h/ohmydsh-0.1.1-linux-x86_64.AppImage' }, signed: false, log() {}, notify: (n) => seen.push(n.kind), enabled: true, timing: { setTimer: c.setTimer, clearTimer: c.clearTimer, now: c.now } })
  assert.equal(au.autoDownload, true); assert.equal(au.autoInstallOnAppQuit, true); assert.equal(typeof au.quitAndInstall, 'undefined')
  u.start(); await c.advance(20_000); assert.deepEqual(seen, []) // a background check with nothing new is silent
  await u.check(); assert.deepEqual(seen, ['none'])
  au.r = { isUpdateAvailable: true, updateInfo: { version: '0.1.4' } }
  au.emit('update-downloaded', { version: '0.1.4' }); au.emit('update-downloaded', { version: '0.1.4' })
  assert.deepEqual(seen, ['none', 'downloaded']) // once per version
  u.stop()
})
test('builds that cannot update themselves ask GitHub every 6 h and announce a newer release once', async () => {
  const au = new EventEmitter(); const seen = []; const c = fakeClock(); let calls = 0
  const fetchImpl = async () => { calls += 1; return { ok: true, json: async () => ({ tag_name: 'v0.2.0', html_url: 'https://x/releases/v0.2.0' }) } }
  const u = startUpdater({ autoUpdater: au, platform: 'darwin', packaged: true, env: {}, signed: false, log() {}, notify: (n) => seen.push([n.kind, n.version]), enabled: true, currentVersion: '0.1.3', fetchImpl, timing: { setTimer: c.setTimer, clearTimer: c.clearTimer, now: c.now } })
  assert.equal(u.active, false); u.start()
  await c.advance(20_000); await c.advance(SIX_HOURS); await c.advance(SIX_HOURS)
  assert.equal(calls, 3); assert.deepEqual(seen, [['manual-available', '0.2.0']])
  u.stop()
})
test('version order', () => {
  assert.equal(isNewer('0.1.4', '0.1.3'), true); assert.equal(isNewer('0.1.3', '0.1.3'), false); assert.equal(isNewer('0.1.2', '0.1.3'), false)
  assert.equal(isNewer('0.2.0', '0.2.0-rc.1'), true); assert.equal(isNewer('0.2.0-rc.2', '0.2.0-rc.10'), false); assert.equal(isNewer('v1.0.0', '0.9.9'), true)
  assert.equal(isNewer('garbage', '0.1.0'), false)
})
test('AppImage replaced through a symlink: the symlink follows the new versioned file', { skip: process.platform === 'win32' }, () => {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'omd-link-'))
  const old = path.join(dir, 'ohmydsh-0.1.1-linux-x86_64.AppImage'); const next = path.join(dir, 'ohmydsh-0.1.4-linux-x86_64.AppImage')
  fs.writeFileSync(old, 'old'); fs.symlinkSync('ohmydsh-0.1.1-linux-x86_64.AppImage', path.join(dir, 'ohmydsh.AppImage')) // the user's relative link
  fs.symlinkSync(old, path.join(dir, 'abs.AppImage')); fs.symlinkSync('/elsewhere', path.join(dir, 'other'))
  fs.unlinkSync(old); fs.writeFileSync(next, 'new') // what electron-updater does
  const moved = repointSymlinks(old, next).map((f) => path.basename(f)).sort()
  assert.deepEqual(moved, ['abs.AppImage', 'ohmydsh.AppImage'])
  assert.equal(fs.readlinkSync(path.join(dir, 'ohmydsh.AppImage')), 'ohmydsh-0.1.4-linux-x86_64.AppImage') // still relative
  assert.equal(fs.readlinkSync(path.join(dir, 'abs.AppImage')), next)
  assert.equal(fs.readFileSync(path.join(dir, 'ohmydsh.AppImage'), 'utf8'), 'new')
  assert.equal(fs.readlinkSync(path.join(dir, 'other')), '/elsewhere')
  fs.rmSync(dir, { recursive: true })
})
test('appimage-filename-updated moves symlinks and logs it', () => {
  const au = new EventEmitter(); const logs = []; let args
  startUpdater({ autoUpdater: au, platform: 'linux', packaged: true, env: { APPIMAGE: '/h/ohmydsh-0.1.1-linux-x86_64.AppImage', OHMYDSH_APPIMAGE_LINKS: '/l/ohmydsh.AppImage' }, signed: false, log: (l) => logs.push(l), notify() {}, enabled: true, repoint: (...a) => { args = a; return ['/l/ohmydsh.AppImage'] } })
  au.emit('appimage-filename-updated', '/h/ohmydsh-0.1.4-linux-x86_64.AppImage')
  assert.deepEqual(args, [path.resolve('/h/ohmydsh-0.1.1-linux-x86_64.AppImage'), path.resolve('/h/ohmydsh-0.1.4-linux-x86_64.AppImage'), ['/l/ohmydsh.AppImage']])
  assert.match(logs.join('\n'), /moved 1 symlink/)
})
