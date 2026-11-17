'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { normalize, loadSettings, saveSettings, DEFAULTS } = require('../src/settings')

test('defaults: fixed port, loopback only', () => {
  assert.deepEqual(normalize(undefined), { ...DEFAULTS, trustedHosts: [] }); assert.equal(DEFAULTS.host, '127.0.0.1')
})
test('invalid values fall back; a wildcard bind is never accepted', () => {
  const s = normalize({ port: 80, host: '0.0.0.0', trustedHosts: ['ok.ts.net', 'bad host', 5], autoUpdate: 'no' })
  assert.equal(s.port, DEFAULTS.port); assert.equal(s.host, '127.0.0.1'); assert.deepEqual(s.trustedHosts, ['ok.ts.net']); assert.equal(s.autoUpdate, true)
  assert.equal(normalize({ host: '::' }).host, '127.0.0.1'); assert.equal(normalize({ host: '192.168.1.5', port: 50000 }).port, 50000)
})
test('round trip through a file, missing and corrupt files', () => {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'omd-set-'))
  const file = path.join(dir, 'settings.json')
  assert.equal(loadSettings(file).port, DEFAULTS.port)
  saveSettings(file, { port: 45000, autoUpdate: false }); assert.deepEqual([loadSettings(file).port, loadSettings(file).autoUpdate], [45000, false])
  fs.writeFileSync(file, '{nope'); assert.equal(loadSettings(file).port, DEFAULTS.port)
  fs.rmSync(dir, { recursive: true })
})
