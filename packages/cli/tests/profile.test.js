import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { readLock } from '../src/lock.js'
import { parseManifest } from '../src/manifest.js'
import { buildPackageJson, patchApplied, prevName, profileDir, rollbackSwap, stagingName, swapIn, syncProfile } from '../src/profile.js'
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

test('buildPackageJson puts a new bundle before the plugins that come after it in the manifest (patch order)', () => {
  const lock = { plugins: { 'dsh-old': {}, 'omd-studio': {}, 'omd-takeover': {} }, official: [] }
  const existing = { name: 'p', dependencies: { 'dsh-old': '1.0.0', 'omd-studio': '1', 'omd-takeover': '1' }, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'dsh-old', 'omd-studio', 'omd-takeover'] } } }
  const mk = (v) => ({ version: v, spec: v, origin: ['core'] })
  const desired = new Map([['omd-browser', mk('2')], ['omd-studio', mk('1')], ['omd-takeover', mk('1')]])
  const pkg = buildPackageJson(existing, { desired, lock, official: [], profile: 'omd' })
  assert.deepEqual(pkg.dsh.profile.bundles, ['@deepseek-ai/dsh-base', 'omd-browser', 'omd-studio', 'omd-takeover'])
  const none = buildPackageJson(null, { desired, lock: null, official: [], profile: 'omd' })
  assert.deepEqual(none.dsh.profile.bundles.slice(2), ['omd-browser', 'omd-studio', 'omd-takeover'])
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

// ---- patched community packages -------------------------------------------------------------------------------------

const PATCH_TEXT = 'diff --git a/lib/index.js b/lib/index.js\n--- a/lib/index.js\n+++ b/lib/index.js\n@@ -1 +1 @@\n-a\n+b\n'
const KEY = 'dsh-a@1.0.0'
const patchedLoaded = async (overrides = {}) => {
  const l = await loaded({ patches: { [KEY]: { file: 'profile/patches/a.patch', note: 'does a', issue: 'https://github.com/o/r/issues/1' } }, ...overrides })
  return { ...l, readRelative: async (rel) => { if (rel !== 'profile/patches/a.patch') throw new Error(`no such file ${rel}`); return PATCH_TEXT } }
}
/** A runner like fakeRunner that also records pnpm's lockfile entry for patched packages, as pnpm 12 does. */
function patchingRunner(home) {
  const base = fakeRunner(home)
  const run = (cmd, args, o) => {
    if (args.includes('install')) {
      const dir = join(home, 'profiles', args[args.indexOf('--profile') + 1])
      const ws = readFileSync(join(dir, 'pnpm-workspace.yaml'), 'utf8')
      // pnpm refuses a patch it does not use: the same strictness as the real thing
      for (const m of ws.matchAll(/^ {2}'([^']+)': '([^']+)'$/gm)) {
        if (!m[2].startsWith('patches/')) continue
        if (!existsSync(join(dir, m[2]))) return { status: 1, stdout: '', stderr: `ERR_PNPM_PATCH_NOT_FOUND ${m[2]}` }
        const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
        const at = m[1].lastIndexOf('@')
        if (pkg.dependencies[m[1].slice(0, at)] !== m[1].slice(at + 1)) return { status: 1, stdout: '', stderr: `ERR_PNPM_UNUSED_PATCH ${m[1]}` }
        writeFileSync(join(dir, 'pnpm-lock.yaml'), `packages:\n  '${m[1]}(patch_hash=abc)': {}\n`)
      }
    }
    return base.run(cmd, args, o)
  }
  return { run, calls: base.calls }
}

test('a patch in the manifest is copied into the profile, written to the managed block and recorded in the lock', async () => {
  const home = tmp()
  const log = silentLog()
  const ctx = ctxFor(home, { run: patchingRunner(home).run, log })
  const res = await syncProfile(ctx, { loaded: await patchedLoaded(), name: 'omd', packs: [], dev: false })
  const live = profileDir(home, 'omd')
  assert.equal(readFileSync(join(live, 'patches/ohmydsh/dsh-a@1.0.0.patch'), 'utf8'), PATCH_TEXT)
  assert.match(readFileSync(join(live, 'pnpm-workspace.yaml'), 'utf8'), /patchedDependencies:\n {2}'dsh-a@1\.0\.0': 'patches\/ohmydsh\/dsh-a@1\.0\.0\.patch'/)
  assert.deepEqual(readLock(live).patches, { [KEY]: { note: 'does a', issue: 'https://github.com/o/r/issues/1' } })
  assert.deepEqual(res.patches.map((p) => p.key), [KEY])
  assert.ok(log.lines.some((l) => l.startsWith('ok: patched dsh-a@1.0.0: does a')))
  assert.equal(patchApplied(live, KEY), true)
  assert.equal(patchApplied(live, 'dsh-a@9.9.9'), false)
})

test('a pinned version that is not the patched one writes no patch at all (pnpm would fail the install)', async () => {
  const home = tmp()
  const ctx = ctxFor(home, { run: patchingRunner(home).run })
  const m = await patchedLoaded({ plugins: { core: { 'dsh-a': '1.0.1', '@ohmydsh/b': '0.1.0' }, packs: {} } })
  await syncProfile(ctx, { loaded: m, name: 'omd', packs: [], dev: false })
  const live = profileDir(home, 'omd')
  assert.ok(!readFileSync(join(live, 'pnpm-workspace.yaml'), 'utf8').includes('patchedDependencies'))
  assert.equal(existsSync(join(live, 'patches')), false)
  assert.deepEqual(readLock(live).patches, {})
})

test('a patch for a pack that is off is not applied; turning the pack on applies it', async () => {
  const home = tmp()
  const ctx = ctxFor(home, { run: patchingRunner(home).run })
  const l = async () => {
    const x = await patchedLoaded({ patches: { 'dsh-c@2.0.0': { file: 'profile/patches/a.patch' } } })
    return x
  }
  await syncProfile(ctx, { loaded: await l(), name: 'omd', packs: [], dev: false })
  const live = profileDir(home, 'omd')
  assert.equal(existsSync(join(live, 'patches')), false)
  await syncProfile(ctx, { loaded: await l(), name: 'omd', packs: ['extra'], dev: false })
  assert.equal(existsSync(join(live, 'patches/ohmydsh/dsh-c@2.0.0.patch')), true)
  await syncProfile(ctx, { loaded: await l(), name: 'omd', packs: [], dev: false })
  assert.equal(existsSync(join(live, 'patches')), false, 'the pack was removed, so the patch goes too')
})

test('dropping the patch from the manifest removes it from the profile; the user\'s own patches stay', async () => {
  const home = tmp()
  const ctx = ctxFor(home, { run: patchingRunner(home).run })
  await syncProfile(ctx, { loaded: await patchedLoaded(), name: 'omd', packs: [], dev: false })
  const live = profileDir(home, 'omd')
  mkdirSync(join(live, 'patches'), { recursive: true })
  writeFileSync(join(live, 'patches/mine.patch'), 'mine')
  writeFileSync(join(live, 'patches/ohmydsh/stale.patch'), 'left behind')
  await syncProfile(ctx, { loaded: await loaded(), name: 'omd', packs: [], dev: false })
  assert.equal(existsSync(join(live, 'patches/ohmydsh')), false)
  assert.equal(readFileSync(join(live, 'patches/mine.patch'), 'utf8'), 'mine')
  assert.ok(!readFileSync(join(live, 'pnpm-workspace.yaml'), 'utf8').includes('patchedDependencies'))
  assert.deepEqual(readLock(live).patches, {})
  // and rolling back returns the patched profile as it was
  rollbackSwap(ctx, 'omd')
  assert.equal(existsSync(join(live, 'patches/ohmydsh/dsh-a@1.0.0.patch')), true)
  assert.deepEqual(Object.keys(readLock(live).patches), [KEY])
})

test('a patch that cannot be read or is not a git diff fails the sync and leaves the live profile alone', async () => {
  const home = tmp()
  const ctx = ctxFor(home, { run: patchingRunner(home).run })
  await syncProfile(ctx, { loaded: await loaded(), name: 'omd', packs: [], dev: false })
  const live = profileDir(home, 'omd')
  const before = readFileSync(join(live, 'ohmydsh.lock.json'), 'utf8')
  const broken = { ...(await patchedLoaded({ version: '0.5.0' })), readRelative: async () => { throw new Error('HTTP 404') } }
  await assert.rejects(() => syncProfile(ctx, { loaded: broken, name: 'omd', packs: [], dev: false }), /the patch for dsh-a@1\.0\.0 \(profile\/patches\/a\.patch\) could not be read: HTTP 404/)
  const html = { ...(await patchedLoaded({ version: '0.5.0' })), readRelative: async () => '<html>404</html>' }
  await assert.rejects(() => syncProfile(ctx, { loaded: html, name: 'omd', packs: [], dev: false }), /is not a git diff/)
  assert.equal(readFileSync(join(live, 'ohmydsh.lock.json'), 'utf8'), before)
  assert.equal(existsSync(profileDir(home, stagingName('omd'))), false)
})

test('a patchedDependencies the user already has wins: warned, the patch is neither copied nor claimed in the lock', async () => {
  const home = tmp()
  const log = silentLog()
  const ctx = ctxFor(home, { run: patchingRunner(home).run, log })
  await syncProfile(ctx, { loaded: await loaded(), name: 'omd', packs: [], dev: false })
  const live = profileDir(home, 'omd')
  writeFileSync(join(live, 'pnpm-workspace.yaml'), `${readFileSync(join(live, 'pnpm-workspace.yaml'), 'utf8')}patchedDependencies:\n  mine@1.0.0: patches/mine.patch\n`)
  await syncProfile(ctx, { loaded: await patchedLoaded({ version: '0.5.0' }), name: 'omd', packs: [], dev: false })
  assert.match(log.lines.join('\n'), /already has its own patchedDependencies/)
  assert.equal(existsSync(join(live, 'patches/ohmydsh')), false)
  assert.deepEqual(readLock(live).patches, {})
  assert.ok(readFileSync(join(live, 'pnpm-workspace.yaml'), 'utf8').includes('mine@1.0.0: patches/mine.patch'))
})

test('dry run lists the patches it would apply and writes nothing', async () => {
  const home = tmp()
  const res = await syncProfile(ctxFor(home, { run: () => { throw new Error('must not run') } }), { loaded: await patchedLoaded(), name: 'omd', packs: [], dev: false, dryRun: true })
  assert.deepEqual(res.patches.map((p) => p.key), [KEY])
  assert.equal(existsSync(join(home, 'profiles')), false)
})
