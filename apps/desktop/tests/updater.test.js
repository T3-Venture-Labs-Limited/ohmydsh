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
test('disabled by setting or env; otherwise wires events and checks', () => {
  const au = Object.assign(new (require('node:events').EventEmitter)(), { checks: 0, checkForUpdates() { this.checks += 1; return Promise.resolve() } })
  assert.equal(startUpdater({ autoUpdater: au, platform: 'win32', packaged: true, env: {}, log() {}, notify() {}, enabled: false }).active, false)
  assert.equal(startUpdater({ autoUpdater: au, platform: 'win32', packaged: true, env: { OHMYDSH_NO_UPDATE: '1' }, log() {}, notify() {}, enabled: true }).active, false)
  const seen = []; const u = startUpdater({ autoUpdater: au, platform: 'win32', packaged: true, env: {}, log() {}, notify: (n) => seen.push(n), enabled: true })
  assert.equal(u.active, true); u.check(); assert.equal(au.checks, 1)
  au.emit('update-downloaded', { version: '0.2.0' }); assert.deepEqual(seen, [{ kind: 'downloaded', version: '0.2.0' }])
})
