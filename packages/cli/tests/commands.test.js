import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { describePatches, doctor, list } from '../src/commands.js'
import { writeLock } from '../src/lock.js'
import { baseManifest, fakeProfile, silentLog, tmp } from './helpers.js'

const KEY = 'dsh-a@1.0.0'
const ISSUE = 'https://github.com/o/r/issues/1'

test('describePatches: name@version, what it does and where to follow up', () => {
  assert.deepEqual(describePatches({ patches: { [KEY]: { note: 'does a', issue: ISSUE }, 'x@2.0.0': {} } }), [`patched: ${KEY}, does a, see ${ISSUE}`, 'patched: x@2.0.0'])
  assert.deepEqual(describePatches({}), [])
  assert.deepEqual(describePatches(null), [])
})

/** A profile as omd leaves it after installing a patched dsh-a; `drift` breaks one thing so doctor has to notice. */
function patchedProfile({ drift } = {}) {
  const home = tmp()
  const manifest = { ...baseManifest(), patches: { [KEY]: { file: 'p.patch', note: 'does a', issue: ISSUE } } }
  const manifestFile = join(home, 'ohmydsh.json')
  writeFileSync(manifestFile, JSON.stringify(manifest))
  const dir = fileProfile(home)
  const lock = { lockVersion: 1, manifest: { version: '0.1.0', dsh: manifest.dsh, source: manifestFile }, dsh: { version: manifest.dsh, previous: null }, dev: false, packs: [], official: [], trustedHosts: [], patches: { [KEY]: { note: 'does a', issue: ISSUE } }, plugins: { 'dsh-a': { version: '1.0.0', spec: '1.0.0', origin: ['core'] }, '@ohmydsh/b': { version: '0.1.0', spec: '0.1.0', origin: ['core'] } } }
  writeLock(dir, lock)
  mkdirSync(join(dir, 'patches/ohmydsh'), { recursive: true })
  if (drift !== 'file') writeFileSync(join(dir, 'patches/ohmydsh/dsh-a@1.0.0.patch'), 'diff --git a/x b/x\n')
  writeFileSync(join(dir, 'pnpm-lock.yaml'), drift === 'lockfile' ? 'packages:\n  dsh-a@1.0.0: {}\n' : `packages:\n  '${KEY}(patch_hash=abc)': {}\n`)
  for (const [n, v] of [['dsh-a', drift === 'version' ? '1.0.1' : '1.0.0'], ['@ohmydsh/b', '0.1.0']]) {
    mkdirSync(join(dir, 'node_modules', ...n.split('/')), { recursive: true })
    writeFileSync(join(dir, 'node_modules', ...n.split('/'), 'package.json'), JSON.stringify({ name: n, version: v }))
  }
  const run = (cmd, args) => {
    if (cmd === 'dsh' && args.includes('--version')) return { status: 0, stdout: `${manifest.dsh}\n`, stderr: '' }
    if (cmd === 'dsh' && args.includes('--dump-config')) return { status: 0, stdout: '# == dsh-a\n# == @ohmydsh/b\n', stderr: '' }
    return { status: 1, stdout: '', stderr: '' }
  }
  const log = silentLog()
  return { ctx: { home, env: { ANTHROPIC_API_KEY: 'x' }, run, log, flags: { manifest: manifestFile }, exitCode: 0 }, log, dir }
}
const fileProfile = (home) => fakeProfile(home, 'omd', { 'package.json': { name: 'p', dependencies: { 'dsh-a': '1.0.0', '@ohmydsh/b': '0.1.0' } }, 'cordis.patch.yml': '[]\n' })

test('doctor: a patched package that is in effect is reported as patched with the upstream link, and is not a problem', async () => {
  const { ctx, log } = patchedProfile()
  const { problems } = await doctor(ctx)
  assert.deepEqual(problems, [])
  assert.ok(log.lines.some((l) => l === `info: patched: ${KEY}, does a, see ${ISSUE}`), log.lines.join('\n'))
})

for (const [drift, what] of [['file', /the patch file patches\/ohmydsh\/dsh-a@1\.0\.0\.patch is missing/], ['lockfile', /pnpm-lock\.yaml does not record the patch/], ['version', /dsh-a is installed at 1\.0\.1, not 1\.0\.0/]]) {
  test(`doctor: a patch that is not in effect (${drift}) is a problem that says what to run`, async () => {
    const { ctx } = patchedProfile({ drift })
    const { problems } = await doctor(ctx)
    const p = problems.find((x) => x.startsWith(`patched ${KEY} is not in effect`))
    assert.ok(p, problems.join('\n'))
    assert.match(p, what)
    assert.match(p, /omd setup/)
    assert.equal(ctx.exitCode, 1)
  })
}

test('list: prints the patched line and the JSON carries the lock with its patches', async () => {
  const { ctx, log } = patchedProfile()
  ctx.flags = { ...ctx.flags }
  await list(ctx)
  assert.ok(log.lines.some((l) => l === `raw: patched: ${KEY}, does a, see ${ISSUE}`), log.lines.join('\n'))
  const json = patchedProfile()
  json.ctx.flags.json = true
  await list(json.ctx)
  assert.deepEqual(JSON.parse(json.log.lines.find((l) => l.startsWith('raw: {')).slice(5)).lock.patches, { [KEY]: { note: 'does a', issue: ISSUE } })
})
