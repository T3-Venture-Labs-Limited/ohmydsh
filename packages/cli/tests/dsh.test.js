import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { doctor, rollback, setup, update } from '../src/commands.js'
import { detectDshInstall } from '../src/dsh.js'
import { lockedDsh, readLock } from '../src/lock.js'
import { profileDir } from '../src/profile.js'
import { baseManifest, silentLog, tmp } from './helpers.js'

/**
 * A machine with a fake npm-global DSH and a fake runner. `world.global` is the installed DSH version, `world.staged`
 * the one in the temporary prefix; --dump-config fails for any DSH version listed in `world.broken`.
 */
function machine({ globalVersion = '0.2.2-rc.3', broken = [], failGlobalInstall = false, kind = 'npm' } = {}) {
  const root = tmp('omd-dsh-')
  const home = join(root, 'dsh-home')
  const prefix = join(root, 'prefix')
  const binJs = join(prefix, 'lib', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  mkdirSync(join(prefix, 'bin'), { recursive: true })
  mkdirSync(join(binJs, '..'), { recursive: true })
  writeFileSync(binJs, '#!/usr/bin/env node\n')
  if (kind === 'unmanaged') { writeFileSync(join(prefix, 'bin', 'dsh'), '#!/bin/sh\n') } else symlinkSync(binJs, join(prefix, 'bin', 'dsh'))
  const world = { global: globalVersion, staged: null, broken: new Set(broken), calls: [], failGlobalInstall }
  const env = { PATH: join(prefix, 'bin') }
  const run = (cmd, args, opts = {}) => {
    world.calls.push([cmd, ...args].join(' '))
    const staged = (opts.env?.PATH ?? '').startsWith(join(home, '.omd-dsh-stage'))
    const version = staged ? world.staged : world.global
    if (cmd === 'npm' && args[0] === 'install') {
      const spec = args.at(-1)
      const v = spec.split('@').pop()
      const pfx = args[args.indexOf('--prefix') + 1]
      if (pfx && pfx.startsWith(join(home, '.omd-dsh-stage'))) { world.staged = v; mkdirSync(join(pfx, 'bin'), { recursive: true }); return { status: 0, stdout: '', stderr: '' } }
      if (world.failGlobalInstall && v !== world.global) return { status: 1, stdout: '', stderr: 'npm ERR! EACCES' }
      world.global = v
      return { status: 0, stdout: '', stderr: '' }
    }
    if (cmd === 'dsh' && args[0] === '--version') return { status: 0, stdout: `${version}\n`, stderr: '' }
    if (cmd === 'dsh' && args.includes('install')) return { status: 0, stdout: '', stderr: '' }
    if (cmd === 'dsh' && args.includes('--dump-config')) {
      if (world.broken.has(version)) return { status: 0, stdout: '', stderr: 'patch: entry "ghost" not found\n' }
      const profile = args[args.indexOf('--profile') + 1]
      const dir = join(home, 'profiles', profile)
      const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
      const patch = readFileSync(join(dir, 'cordis.patch.yml'), 'utf8')
      const stdout = [...Object.keys(pkg.dependencies).map((n) => `# == ${n}\n- id: ${n}\n`), ...[...patch.matchAll(/id: (\S+)/g)].map((m) => `- id: ${m[1]}\n`)].join('')
      return { status: 0, stdout, stderr: '' }
    }
    return { status: 0, stdout: '', stderr: '' }
  }
  const manifestFile = (dsh, version) => {
    const file = join(root, `ohmydsh-${version}.json`)
    writeFileSync(file, JSON.stringify({ ...baseManifest(), version, dsh }))
    return file
  }
  const ctx = (manifest, flags = {}) => ({ flags: { manifest, ...flags }, env, home, run, fetch: globalThis.fetch, log: silentLog(), cliDir: root, exitCode: 0, isRunning: () => false, bootCheck: async () => ({ ok: true }) })
  return { world, home, ctx, manifestFile, root }
}

const live = (m) => profileDir(m.home, 'omd')
const npmInstalls = (m) => m.world.calls.filter((c) => c.startsWith('npm install'))

test('detectDshInstall: npm global, unmanaged binary, none', () => {
  const m = machine()
  assert.equal(detectDshInstall(m.ctx(null)).kind, 'npm')
  assert.equal(detectDshInstall({ env: { PATH: '/nonexistent' } }).kind, 'none')
  const u = machine({ kind: 'unmanaged' })
  assert.equal(detectDshInstall(u.ctx(null)).kind, 'unmanaged')
})

test('update with an unchanged DSH pin never touches DSH', async () => {
  const m = machine()
  await setup(m.ctx(m.manifestFile('0.2.2-rc.3', '0.1.0')))
  m.world.calls.length = 0
  await update(m.ctx(m.manifestFile('0.2.2-rc.3', '0.1.1')))
  assert.equal(npmInstalls(m).length, 0)
  assert.equal(m.world.global, '0.2.2-rc.3')
  assert.equal(readLock(live(m)).manifest.version, '0.1.1')
  assert.equal(readLock(live(m)).dsh.previous, null)
})

test('update with a changed pin: the new DSH is tried in a temporary prefix, then switched; the lock remembers the previous one', async () => {
  const m = machine()
  await setup(m.ctx(m.manifestFile('0.2.2-rc.3', '0.1.0')))
  m.world.calls.length = 0
  await update(m.ctx(m.manifestFile('0.2.2-rc.5', '0.1.1')))
  const installs = npmInstalls(m)
  assert.equal(installs.length, 2)
  assert.match(installs[0], /--prefix \S+\.omd-dsh-stage/)
  assert.doesNotMatch(installs[1], /omd-dsh-stage/)
  // the staged binary checked the staged profile, before the global one moved
  const firstCompose = m.world.calls.findIndex((c) => c.includes('--dump-config'))
  const switchIdx = m.world.calls.findIndex((c, i) => i > 0 && c.startsWith('npm install') && !c.includes('omd-dsh-stage'))
  assert.ok(firstCompose !== -1 && firstCompose < switchIdx)
  assert.equal(m.world.global, '0.2.2-rc.5')
  const lock = readLock(live(m))
  assert.deepEqual(lock.dsh, { version: '0.2.2-rc.5', previous: '0.2.2-rc.3' })
  assert.equal(lock.manifest.dsh, '0.2.2-rc.5')
})

test('update with a changed pin and a failing check changes nothing (profile, lock and DSH)', async () => {
  const m = machine({ broken: ['0.2.2-rc.5'] })
  await setup(m.ctx(m.manifestFile('0.2.2-rc.3', '0.1.0')))
  const before = readFileSync(join(live(m), 'ohmydsh.lock.json'), 'utf8')
  m.world.calls.length = 0
  await assert.rejects(update(m.ctx(m.manifestFile('0.2.2-rc.5', '0.1.1'))), /does not compose cleanly/)
  assert.equal(m.world.global, '0.2.2-rc.3')
  assert.equal(readFileSync(join(live(m), 'ohmydsh.lock.json'), 'utf8'), before)
  assert.equal(npmInstalls(m).filter((c) => !c.includes('omd-dsh-stage')).length, 0)
})

test('a switch that fails after the profile swap puts the old profile back and DSH stays at the old version', async () => {
  const m = machine({ failGlobalInstall: true })
  await setup(m.ctx(m.manifestFile('0.2.2-rc.3', '0.1.0')))
  await assert.rejects(update(m.ctx(m.manifestFile('0.2.2-rc.5', '0.1.1'))), /could not switch DSH[\s\S]*previous profile is active again/)
  assert.equal(m.world.global, '0.2.2-rc.3')
  assert.equal(readLock(live(m)).manifest.version, '0.1.0')
  assert.equal(await doctorProblems(m), 0)
})

async function doctorProblems(m) {
  const ctx = m.ctx(m.manifestFile(m.world.global, '0.1.0'))
  const r = await doctor(ctx)
  return r.problems.filter((p) => /dsh/i.test(p) && /installed/.test(p)).length
}

test('rollback restores the previous DSH together with the previous profile, and rolling back again undoes both', async () => {
  const m = machine()
  await setup(m.ctx(m.manifestFile('0.2.2-rc.3', '0.1.0')))
  await update(m.ctx(m.manifestFile('0.2.2-rc.5', '0.1.1')))
  assert.equal(m.world.global, '0.2.2-rc.5')
  await rollback(m.ctx(null))
  assert.equal(m.world.global, '0.2.2-rc.3')
  assert.equal(readLock(live(m)).manifest.version, '0.1.0')
  await rollback(m.ctx(null))
  assert.equal(m.world.global, '0.2.2-rc.5')
  assert.equal(readLock(live(m)).manifest.version, '0.1.1')
})

test('rollback whose DSH switch fails is undone, so profile and DSH still match', async () => {
  const m = machine()
  await setup(m.ctx(m.manifestFile('0.2.2-rc.3', '0.1.0')))
  await update(m.ctx(m.manifestFile('0.2.2-rc.5', '0.1.1')))
  m.world.failGlobalInstall = true
  await assert.rejects(rollback(m.ctx(null)), /rollback was undone/)
  assert.equal(m.world.global, '0.2.2-rc.5')
  assert.equal(readLock(live(m)).manifest.version, '0.1.1')
})

test('--no-dsh-install is respected by setup and update: DSH is never installed or replaced, the lock records the real DSH', async () => {
  const m = machine()
  await setup(m.ctx(m.manifestFile('0.2.2-rc.3', '0.1.0'), { 'no-dsh-install': true }))
  m.world.calls.length = 0
  const ctx = m.ctx(m.manifestFile('0.2.2-rc.5', '0.1.1'), { 'no-dsh-install': true })
  await update(ctx)
  assert.equal(npmInstalls(m).length, 0)
  assert.equal(m.world.global, '0.2.2-rc.3')
  assert.deepEqual(readLock(live(m)).dsh, { version: '0.2.2-rc.3', previous: null })
  assert.equal(lockedDsh(readLock(live(m))), '0.2.2-rc.3')
  assert.ok(ctx.log.lines.some((l) => /^warn: .*Not changing it \(--no-dsh-install\)/.test(l)))
  await setup(m.ctx(m.manifestFile('0.2.2-rc.5', '0.1.1'), { 'no-dsh-install': true }))
  assert.equal(npmInstalls(m).length, 0)
})

test('a DSH omd did not install (the desktop app runtime) is left alone even without the flag', async () => {
  const m = machine({ kind: 'unmanaged' })
  await setup(m.ctx(m.manifestFile('0.2.2-rc.3', '0.1.0')))
  m.world.calls.length = 0
  const ctx = m.ctx(m.manifestFile('0.2.2-rc.5', '0.1.1'))
  await update(ctx)
  assert.equal(npmInstalls(m).length, 0)
  assert.ok(ctx.log.lines.some((l) => /not installed by npm or mise/.test(l)))
})

test('dry run reports the DSH move and installs nothing', async () => {
  const m = machine()
  await setup(m.ctx(m.manifestFile('0.2.2-rc.3', '0.1.0')))
  m.world.calls.length = 0
  const ctx = m.ctx(m.manifestFile('0.2.2-rc.5', '0.1.1'), { 'dry-run': true })
  await update(ctx)
  assert.equal(npmInstalls(m).length, 0)
  assert.ok(ctx.log.lines.some((l) => /DSH 0\.2\.2-rc\.3 -> 0\.2\.2-rc\.5 would be installed/.test(l)))
})

test('doctor reports a DSH that no longer matches the lock', async () => {
  const m = machine()
  await setup(m.ctx(m.manifestFile('0.2.2-rc.3', '0.1.0')))
  m.world.global = '0.2.2-rc.4'
  const ctx = m.ctx(m.manifestFile('0.2.2-rc.3', '0.1.0'))
  const r = await doctor(ctx)
  assert.ok(r.problems.some((p) => /0\.2\.2-rc\.4 is installed but this profile was installed and checked with dsh 0\.2\.2-rc\.3/.test(p)))
})

test('setup repairs a drifted DSH (npm global) by installing the pinned one after the profile checks out', async () => {
  const m = machine({ globalVersion: '0.2.2-rc.4' })
  const ctx = m.ctx(m.manifestFile('0.2.2-rc.5', '0.1.0'))
  await setup(ctx)
  assert.equal(m.world.global, '0.2.2-rc.5')
  assert.deepEqual(readLock(live(m)).dsh, { version: '0.2.2-rc.5', previous: '0.2.2-rc.4' })
})
