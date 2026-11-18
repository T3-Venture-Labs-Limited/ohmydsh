'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { writeShims, childEnv } = require('../src/shims')

test('writes node/dsh/omd launchers that run Electron as Node (unix and windows forms)', () => {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'omd-shim-'))
  const files = writeShims({ bin: dir, electron: '/opt/ohmydsh/ohmydsh', dshBin: '/rt/dsh.js', omdBin: '/res/omd.js', platform: 'linux' })
  assert.deepEqual(files.map((f) => path.basename(f)), ['node', 'dsh', 'omd'])
  const dsh = fs.readFileSync(path.join(dir, 'dsh'), 'utf8')
  assert.match(dsh, /ELECTRON_RUN_AS_NODE=1 exec "\/opt\/ohmydsh\/ohmydsh" "\/rt\/dsh\.js" "\$@"/)
  // Windows has no exec bits; the .cmd shims are what run there.
  if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(dir, 'dsh')).mode & 0o111, 0o111)
  const win = writeShims({ bin: dir, electron: 'C:\\ohmydsh.exe', dshBin: 'C:\\dsh.js', omdBin: 'C:\\omd.js', platform: 'win32' })
  assert.match(fs.readFileSync(win[1], 'utf8'), /set ELECTRON_RUN_AS_NODE=1\r\n"C:\\ohmydsh\.exe" "C:\\dsh\.js" %\*/)
  fs.rmSync(dir, { recursive: true })
})
test('child environment: shims first on PATH, DSH_HOME set, Electron acts as Node', () => {
  const env = childEnv({ base: { PATH: '/usr/bin', HOME: '/h' }, bin: '/rt/bin', pnpmDir: '/rt/pnpm', dshHome: '/dsh', platform: 'linux' })
  assert.equal(env.PATH, '/rt/bin:/rt/pnpm:/usr/bin'); assert.equal(env.DSH_HOME, '/dsh'); assert.equal(env.ELECTRON_RUN_AS_NODE, '1'); assert.equal(env.HOME, '/h')
  assert.equal(childEnv({ base: { Path: 'C:\\x' }, bin: 'b', pnpmDir: 'p', dshHome: 'd', platform: 'win32' }).PATH, 'b;p;C:\\x')
})
