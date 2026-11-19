'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { chooseNodeRuntime, bundledNodePath, isExecutableFile } = require('../src/node-runtime')

const base = { resources: '/opt/ohmydsh/resources', execPath: '/opt/ohmydsh/ohmydsh', platform: 'linux' }
const bundled = '/opt/ohmydsh/resources/node/bin/node'

test('OHMYDSH_NODE wins over the bundled Node and Electron when the file exists', () => {
  const r = chooseNodeRuntime({ ...base, env: { OHMYDSH_NODE: '/usr/bin/node' }, exists: () => true, executable: () => true })
  assert.deepEqual([r.exe, r.kind, r.electronAsNode], ['/usr/bin/node', 'env', false])
})
test('a missing OHMYDSH_NODE is ignored and the bundled Node is used (and the note says so)', () => {
  const r = chooseNodeRuntime({ ...base, env: { OHMYDSH_NODE: '/nope/node' }, exists: () => false, executable: (f) => f === bundled })
  assert.deepEqual([r.exe, r.kind, r.electronAsNode], [bundled, 'bundled', false])
  assert.match(r.note, /OHMYDSH_NODE=\/nope\/node does not exist/)
})
test('the bundled Node is used when present and executable', () => {
  const r = chooseNodeRuntime({ ...base, env: {}, exists: () => false, executable: (f) => f === bundled })
  assert.deepEqual([r.exe, r.kind, r.electronAsNode], [bundled, 'bundled', false])
})
test('an empty OHMYDSH_NODE counts as unset', () => {
  assert.equal(chooseNodeRuntime({ ...base, env: { OHMYDSH_NODE: '' }, exists: () => true, executable: () => true }).kind, 'bundled')
})
test('falls back to Electron as Node when there is no bundled Node (macOS, Windows, a stripped build)', () => {
  const r = chooseNodeRuntime({ ...base, env: {}, exists: () => false, executable: () => false })
  assert.deepEqual([r.exe, r.kind, r.electronAsNode], [base.execPath, 'electron', true])
})
test('bundled Node location per platform', () => {
  assert.equal(bundledNodePath('/r', 'linux'), '/r/node/bin/node')
  assert.equal(bundledNodePath('C:\\r', 'win32'), 'C:\\r\\node\\node.exe')
})
test('isExecutableFile: needs a regular file with the execute bit (real files)', { skip: process.platform === 'win32' }, () => {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'omd-node-'))
  const file = path.join(dir, 'node')
  assert.equal(isExecutableFile(file), false)            // missing
  fs.writeFileSync(file, '#!/bin/sh\n', { mode: 0o644 })
  assert.equal(isExecutableFile(file), false)            // not executable
  fs.chmodSync(file, 0o755)
  assert.equal(isExecutableFile(file), true)
  assert.equal(isExecutableFile(dir), false)             // a directory
  fs.rmSync(dir, { recursive: true })
})
