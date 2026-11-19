'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { runSharpJob } = require('../src/sharp-check')

const tmp = () => fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'omd-sharp-'))

test('a child that dies from a signal (the SIGSEGV regression) rejects with the signal name', { skip: process.platform === 'win32' }, async () => {
  const dir = tmp()
  const exe = path.join(dir, 'crash')
  fs.writeFileSync(exe, '#!/bin/sh\nkill -SEGV $$\n', { mode: 0o755 })
  await assert.rejects(runSharpJob({ exe, env: process.env, nodeModules: dir, timeoutMs: 10_000 }), /killed by SIGSEGV/)
  fs.rmSync(dir, { recursive: true })
})
test('a runtime without sharp fails with a readable message', async () => {
  const dir = tmp()
  await assert.rejects(runSharpJob({ exe: process.execPath, env: process.env, nodeModules: dir, timeoutMs: 20_000 }), /sharp is not installed/)
  fs.rmSync(dir, { recursive: true })
})
test('a runtime that cannot start fails', async () => {
  await assert.rejects(runSharpJob({ exe: '/nonexistent/node', env: process.env, nodeModules: '/x' }), /could not start/)
})
