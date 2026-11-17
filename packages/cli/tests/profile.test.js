import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { readLock } from '../src/lock.js'
import { parseManifest } from '../src/manifest.js'
import { buildPackageJson, prevName, profileDir, rollbackSwap, stagingName, swapIn, syncProfile } from '../src/profile.js'
import { baseManifest, fakeProfile, silentLog, tmp } from './helpers.js'

/** A fake `dsh`: `plugin ... install` succeeds, `--dump-config` lists every dependency of the profile it is asked for. */
function fakeRunner(home, { failCompose = false } = {}) {
  const calls = []
  const run = (cmd, args) => {
    calls.push([cmd, ...args])
    const profile = args[args.indexOf('--profile') + 1]
    if (args.includes('install')) return { status: 0, stdout: '', stderr: '' }
    if (args.includes('--dump-config')) {
      const dir = join(home, 'profiles', profile)
      const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
      const patch = readFileSync(join(dir, 'cordis.patch.yml'), 'utf8')
      const stdout = [...Object.keys(pkg.dependencies).map((n) => `# == ${n}\n- id: ${n}\n`), '# == user\n', ...[...patch.matchAll(/id: (\S+)/g)].map((m) => `- id: ${m[1]}\n`)].join('')
      return { status: 0, stdout, stderr: failCompose ? 'patch: entry "ghost" not found\n' : '' }
    }
    return { status: 0, stdout: '', stderr: '' }
  }
  return { run, calls }
}

async function loaded(overrides = {}) {
  const m = baseManifest()
  Object.assign(m, overrides)
  const manifest = parseManifest(JSON.stringify(m))
  return { manifest, source: '/x/ohmydsh.json', readRelative: async () => '' }
}

const ctxFor = (home, extra = {}) => ({ home, env: {}, log: silentLog(), isRunning: () => false, bootCheck: async () => ({ ok: true }), ...extra })

test('buildPackageJson keeps user deps and bundles, removes only what the lock owned', () => {
  const m = baseManifest()
  const lock = { plugins: { 'dsh-a': {}, 'dsh-c': {} }, official: ['@deepseek-ai/old'] }
  const existing = { name: 'p', dependencies: { 'dsh-a': '1.0.0', 'dsh-c': '2.0.0', mine: 'link:/m' }, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'dsh-a', 'dsh-c', 'mine', '@deepseek-ai/old'], patchReload: 'off' } } }
  const desired = new Map([['dsh-a', { version: '1.1.0', spec: '1.1.0', origin: ['core'] }]])
  const pkg = buildPackageJson(existing, { desired, lock, official: ['@deepseek-ai/new'], profile: 'omd' })
  assert.deepEqual(Object.keys(pkg.dependencies), ['dsh-a', 'mine'])
  assert.equal(pkg.dependencies['dsh-a'], '1.1.0')
  assert.deepEqual(pkg.dsh.profile.bundles, ['@deepseek-ai/dsh-base', 'dsh-a', 'mine', '@deepseek-ai/new'])
  assert.equal(pkg.dsh.profile.patchReload, 'off')
  void m
})

test('swapIn / rollbackSwap exchange directories reversibly and keep prev', () => {
  const home = tmp()
  fakeProfile(home, 'omd', { 'marker.txt': 'old' })
  fakeProfile(home, stagingName('omd'), { 'marker.txt': 'new' })
  const ctx = { home }
  swapIn(ctx, 'omd', { hadLive: true })
  assert.equal(readFileSync(join(profileDir(home, 'omd'), 'marker.txt'), 'utf8'), 'new')
  assert.equal(readFileSync(join(profileDir(home, prevName('omd')), 'marker.txt'), 'utf8'), 'old')
  assert.equal(existsSync(profileDir(home, stagingName('omd'))), false)
  rollbackSwap(ctx, 'omd')
  assert.equal(readFileSync(join(profileDir(home, 'omd'), 'marker.txt'), 'utf8'), 'old')
  assert.equal(readFileSync(join(profileDir(home, prevName('omd')), 'marker.txt'), 'utf8'), 'new')
  rollbackSwap(ctx, 'omd')
  assert.equal(readFileSync(join(profileDir(home, 'omd'), 'marker.txt'), 'utf8'), 'new')
})

test('rollback with no previous profile is an error and changes nothing', () => {
  const home = tmp()
  fakeProfile(home, 'omd', { 'marker.txt': 'only' })
  assert.throws(() => rollbackSwap({ home }, 'omd'), /no previous profile/)
  assert.equal(readFileSync(join(profileDir(home, 'omd'), 'marker.txt'), 'utf8'), 'only')
})

test('first sync creates the profile, lock and managed block; a second sync swaps and keeps the old as omd-prev', async () => {
  const home = tmp()
  const { run } = fakeRunner(home)
  const ctx = ctxFor(home, { run })
  const res = await syncProfile(ctx, { loaded: await loaded(), name: 'omd', packs: [], dev: false })
  assert.equal(res.applied, true)
  const live = profileDir(home, 'omd')
  assert.deepEqual(Object.keys(readLock(live).plugins), ['dsh-a', '@ohmydsh/b'])
  assert.match(readFileSync(join(live, 'cordis.patch.yml'), 'utf8'), /^# >>> ohmydsh/)
  assert.equal(existsSync(profileDir(home, prevName('omd'))), false)

  // user adds their own plugin and row; an update must keep both
  const pkg = JSON.parse(readFileSync(join(live, 'package.json'), 'utf8'))
  pkg.dependencies['my-plugin'] = 'link:/home/me/p'
  pkg.dsh.profile.bundles.push('my-plugin')
  writeFileSync(join(live, 'package.json'), JSON.stringify(pkg))
  writeFileSync(join(live, 'cordis.patch.yml'), `${readFileSync(join(live, 'cordis.patch.yml'), 'utf8')}\n- id: my-row\n  name: my-plugin\n`)

  const m2 = baseManifest()
  m2.version = '0.2.0'
  m2.plugins.core['dsh-a'] = '1.1.0'
  const res2 = await syncProfile(ctx, { loaded: await loaded({ version: '0.2.0', plugins: m2.plugins }), name: 'omd', packs: [], dev: false })
  assert.equal(res2.diff.change.length, 1)
  const after = JSON.parse(readFileSync(join(live, 'package.json'), 'utf8'))
  assert.equal(after.dependencies['dsh-a'], '1.1.0')
  assert.equal(after.dependencies['my-plugin'], 'link:/home/me/p')
  assert.match(readFileSync(join(live, 'cordis.patch.yml'), 'utf8'), /id: my-row/)
  assert.equal(readLock(live).manifest.version, '0.2.0')
  assert.equal(readLock(profileDir(home, prevName('omd'))).manifest.version, '0.1.0')
  rollbackSwap(ctx, 'omd')
  assert.equal(readLock(live).manifest.version, '0.1.0')
})

test('a failed health check deletes staging and leaves the live profile untouched', async () => {
  const home = tmp()
  const ok = ctxFor(home, { run: fakeRunner(home).run })
  await syncProfile(ok, { loaded: await loaded(), name: 'omd', packs: [], dev: false })
  const live = profileDir(home, 'omd')
  const before = readFileSync(join(live, 'ohmydsh.lock.json'), 'utf8')
  const bad = ctxFor(home, { run: fakeRunner(home, { failCompose: true }).run })
  await assert.rejects(async () => syncProfile(bad, { loaded: await loaded({ version: '0.3.0' }), name: 'omd', packs: [], dev: false }), /does not compose cleanly[\s\S]*ghost/)
  assert.equal(existsSync(profileDir(home, stagingName('omd'))), false)
  assert.equal(readFileSync(join(live, 'ohmydsh.lock.json'), 'utf8'), before)
  assert.equal(existsSync(profileDir(home, prevName('omd'))), false)
})

test('a failed plugin install also leaves the live profile untouched', async () => {
  const home = tmp()
  const ok = ctxFor(home, { run: fakeRunner(home).run })
  await syncProfile(ok, { loaded: await loaded(), name: 'omd', packs: [], dev: false })
  const failing = ctxFor(home, { run: () => ({ status: 1, stdout: '', stderr: 'ERR_PNPM_FETCH' }) })
  await assert.rejects(async () => syncProfile(failing, { loaded: await loaded({ version: '0.3.0' }), name: 'omd', packs: [], dev: false }), /plugin install failed/)
  assert.equal(readLock(profileDir(home, 'omd')).manifest.version, '0.1.0')
  assert.equal(existsSync(profileDir(home, stagingName('omd'))), false)
})

test('a running DSH blocks the swap unless forced; nothing changes', async () => {
  const home = tmp()
  const ctx = ctxFor(home, { run: fakeRunner(home).run })
  await syncProfile(ctx, { loaded: await loaded(), name: 'omd', packs: [], dev: false })
  const busy = { ...ctx, isRunning: () => true }
  await assert.rejects(async () => syncProfile(busy, { loaded: await loaded({ version: '0.4.0' }), name: 'omd', packs: [], dev: false }), /DSH is running/)
  assert.equal(readLock(profileDir(home, 'omd')).manifest.version, '0.1.0')
  const forced = await syncProfile(busy, { loaded: await loaded({ version: '0.4.0' }), name: 'omd', packs: [], dev: false, force: true })
  assert.equal(forced.running, true)
  assert.equal(readLock(profileDir(home, 'omd')).manifest.version, '0.4.0')
})

test('adding then removing a pack round-trips the profile and drops its dependency', async () => {
  const home = tmp()
  const ctx = ctxFor(home, { run: fakeRunner(home).run })
  await syncProfile(ctx, { loaded: await loaded(), name: 'omd', packs: [], dev: false })
  await syncProfile(ctx, { loaded: await loaded(), name: 'omd', packs: ['extra'], dev: false })
  const live = profileDir(home, 'omd')
  assert.ok(JSON.parse(readFileSync(join(live, 'package.json'), 'utf8')).dependencies['dsh-c'])
  await syncProfile(ctx, { loaded: await loaded(), name: 'omd', packs: [], dev: false })
  const pkg = JSON.parse(readFileSync(join(live, 'package.json'), 'utf8'))
  assert.equal(pkg.dependencies['dsh-c'], undefined)
  assert.equal(pkg.dsh.profile.bundles.includes('dsh-c'), false)
})

test('dry run reports the diff and writes nothing', async () => {
  const home = tmp()
  const res = await syncProfile(ctxFor(home, { run: () => { throw new Error('must not run') } }), { loaded: await loaded(), name: 'omd', packs: [], dev: false, dryRun: true })
  assert.equal(res.applied, false)
  assert.equal(res.diff.add.length, 2)
  assert.equal(existsSync(join(home, 'profiles')), false)
})
