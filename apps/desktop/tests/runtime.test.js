'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { needs } = require('../src/runtime')

const paths = { dshBin: '/r/dsh.js', pnpmExe: '/r/pnpm', dshHome: '/h' }
const wanted = { dsh: '0.2.2-rc.3', pnpm: '12.15.0', manifestVersion: '0.1.0' }
const present = new Set(['/r/dsh.js', '/r/pnpm', '/h/profiles/omd'].map((p) => p.replace(/\//g, require('node:path').sep)))
const exists = (p) => present.has(p)

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
  assert.equal(needs(paths, wanted, { ...wanted }, (p) => p !== '/r/dsh.js').runtime, true)
})
