'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { resolvePaths, pnpmTarget } = require('../src/paths')

test('uses its own DSH home in the app data folder by default', () => {
  const p = resolvePaths({ userData: '/u', resources: '/r', appPath: '/a/app.asar', env: {}, platform: 'linux' })
  assert.equal(p.dshHome, path.join('/u', 'dsh-home')); assert.equal(p.usesOwnHome, true)
  assert.equal(p.dshBin, path.join('/u', 'runtime', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'))
  assert.equal(p.manifest, path.join('/r', 'ohmydsh', 'ohmydsh.json'))
  assert.equal(p.npmCli, path.join('/u', 'runtime', 'npm', 'bin', 'npm-cli.js')); assert.equal(p.npmTarball, path.join('/r', 'npm.tgz'))
})
test('OHMYDSH_DSH_HOME points the app at an existing DSH home; OHMYDSH_MANIFEST at another manifest', () => {
  const p = resolvePaths({ userData: '/u', resources: '/r', appPath: '/a', env: { OHMYDSH_DSH_HOME: '/home/me/.dsh', OHMYDSH_MANIFEST: '/tmp/m.json' }, platform: 'linux' })
  assert.equal(p.dshHome, '/home/me/.dsh'); assert.equal(p.usesOwnHome, false); assert.equal(p.manifest, '/tmp/m.json')
  assert.equal(resolvePaths({ userData: '/u', resources: '/r', appPath: '/a', env: { OHMYDSH_DSH_HOME: '' } }).usesOwnHome, true)
})
test('pnpm target per platform and arch', () => {
  assert.equal(pnpmTarget('win32', 'x64'), 'win32-x64'); assert.equal(pnpmTarget('darwin', 'arm64'), 'darwin-arm64'); assert.equal(pnpmTarget('linux', 'x64'), 'linux-x64')
  assert.match(resolvePaths({ userData: '/u', resources: '/r', appPath: '/a', platform: 'win32' }).pnpmExe, /exe\.win32-x64[\\/]pnpm\.exe$/)
})
