import assert from 'node:assert/strict'
import { chmodSync, writeFileSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { test } from 'node:test'
import { shellFor, which } from '../src/util.js'
import { tmp } from './helpers.js'

function asPlatform(name, fn) {
  const real = Object.getOwnPropertyDescriptor(process, 'platform')
  Object.defineProperty(process, 'platform', { value: name })
  try { return fn() } finally { Object.defineProperty(process, 'platform', real) }
}

test('shellFor: no shell on POSIX; on Windows a shell for .cmd shims, none for .exe, arguments quoted', () => {
  assert.deepEqual(asPlatform('linux', () => shellFor('dsh', ['plugin', 'a b'])), { cmd: 'dsh', args: ['plugin', 'a b'], opts: {} })
  const win = asPlatform('win32', () => shellFor('dsh', ['plugin', '--profile', 'omd-next', 'a b', 'say "hi"']))
  assert.equal(win.opts.shell, true)
  assert.deepEqual(win.args, ['plugin', '--profile', 'omd-next', '"a b"', '"say ""hi"""'])
  assert.deepEqual(asPlatform('win32', () => shellFor('C:\\x\\node.exe', ['a b'])), { cmd: 'C:\\x\\node.exe', args: ['a b'], opts: {} })
})

test('which finds a command on PATH with the platform delimiter and, on Windows, through PATHEXT', () => {
  const dir = tmp()
  writeFileSync(join(dir, 'dsh'), '#!/bin/sh\n')
  chmodSync(join(dir, 'dsh'), 0o755)
  const env = { PATH: ['/nonexistent', dir].join(delimiter) }
  assert.equal(which('dsh', env), join(dir, 'dsh'))
  assert.equal(which('nope', env), null)
  writeFileSync(join(dir, 'tool.CMD'), '')
  assert.equal(asPlatform('win32', () => which('tool', { PATH: dir, PATHEXT: '.COM;.EXE;.BAT;.CMD' })), join(dir, 'tool.CMD'))
  assert.equal(which('tool', { PATH: dir }), null)
})
