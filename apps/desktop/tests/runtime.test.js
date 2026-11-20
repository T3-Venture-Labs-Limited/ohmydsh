'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { needs, tarExe } = require('../src/runtime')

const paths = { dshBin: '/r/dsh.js', pnpmExe: '/r/pnpm', dshHome: '/h' }
const wanted = { dsh: '0.2.2-rc.3', pnpm: '12.15.0', manifestVersion: '0.1.0' }
const present = new Set(['/r/dsh.js', '/r/pnpm', '/h/profiles/omd'])
// needs() joins with the runner's separator; compare in one form so the test is the same on Windows.
const exists = (p) => present.has(p.replace(/\\/g, '/'))

test('fresh install needs both the runtime and the profile', () => {
  assert.deepEqual(needs(paths, wanted, {}, () => false), { runtime: true, profile: true })
})
test('everything current needs nothing', () => {
  assert.deepEqual(needs(paths, wanted, { ...wanted }, exists), { runtime: false, profile: false })
})
test('a new manifest or a new DSH pin re-runs only what changed', () => {
  assert.deepEqual(needs(paths, wanted, { ...wanted, manifestVersion: '0.0.9' }, exists), { runtime: false, profile: true })
  assert.deepEqual(needs(paths, wanted, { ...wanted, dsh: '0.2.1' }, exists), { runtime: true, profile: true })
})
test('a deleted binary is repaired', () => {
  assert.equal(needs(paths, wanted, { ...wanted }, (p) => p.replace(/\\/g, '/') !== '/r/dsh.js').runtime, true)
})
test('tar: System32 bsdtar by full path on Windows, plain tar elsewhere', () => {
  assert.equal(tarExe('win32', { SystemRoot: 'C:\\Windows' }), 'C:\\Windows\\System32\\tar.exe')
  assert.equal(tarExe('darwin', {}), 'tar'); assert.equal(tarExe('linux', {}), 'tar')
})
