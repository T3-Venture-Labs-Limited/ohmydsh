// Patched community packages (ohmydsh.json "patches"): check-manifest, and what the follow workflow does with a new
// version of a package that carries a patch.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { issueBody, mergeResults, patchConflicts, planIssueActions, screenPatched } from '../follow-lib/follow.mjs'

const scripts = join(dirname(fileURLToPath(import.meta.url)), '..')
const ISSUE = 'https://github.com/kenz1117/dsh-engram/issues/64'
const manifest = (patches) => ({
  version: '0.1.3',
  dsh: '0.2.2-rc.3',
  plugins: { core: { 'dsh-a': '1.0.0', '@kenz1117/dsh-engram': '0.13.15' }, packs: { p: { 'dsh-c': '2.0.0' } } },
  sources: {},
  patches: patches ?? { '@kenz1117/dsh-engram@0.13.15': { file: 'profile/patches/e.patch', note: 'start-up pass delayed', issue: ISSUE } },
})

// ---- check-manifest ------------------------------------------------------------------------------------------------

/** A minimal checkout that passes check-manifest, then `mutate` breaks something. */
function repo(mutate = () => {}, { patch = 'diff --git a/lib/index.js b/lib/index.js\n' } = {}) {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'omd-cm-'))
  const m = manifest()
  mutate(m)
  mkdirSync(join(dir, 'packages/cli'), { recursive: true })
  writeFileSync(join(dir, 'packages/cli/package.json'), JSON.stringify({ name: '@t3labs/ohmydsh', version: '0.1.3' }))
  writeFileSync(join(dir, 'ohmydsh.json'), JSON.stringify(m))
  if (patch !== null) { mkdirSync(join(dir, 'profile/patches'), { recursive: true }); writeFileSync(join(dir, 'profile/patches/e.patch'), patch) }
  return dir
}
const check = (dir) => spawnSync('node', [join(scripts, 'check-manifest.mjs'), '--root', dir], { encoding: 'utf8' })

test('check-manifest: a patch for the pinned version with a file, a note and an issue passes', () => {
  const r = check(repo())
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /1 patches/)
})

test('check-manifest: a patch whose version is no longer the pinned one fails and says what to do', () => {
  const r = check(repo((m) => { m.plugins.core['@kenz1117/dsh-engram'] = '0.13.16' }))
  assert.equal(r.status, 1)
  assert.match(r.stderr, /patches\.@kenz1117\/dsh-engram@0\.13\.15: @kenz1117\/dsh-engram is pinned at 0\.13\.16; drop or regenerate the patch/)
})

test('check-manifest: a patch for a package that is not pinned at all fails', () => {
  const r = check(repo((m) => { m.patches = { 'ghost@1.0.0': { file: 'profile/patches/e.patch', note: 'n', issue: ISSUE } } }))
  assert.equal(r.status, 1)
  assert.match(r.stderr, /ghost is pinned at \(not pinned\)/)
})

test('check-manifest: a patch of a package in a pack is checked against that pin too', () => {
  assert.equal(check(repo((m) => { m.patches = { 'dsh-c@2.0.0': { file: 'profile/patches/e.patch', note: 'n', issue: ISSUE } } })).status, 0)
  assert.equal(check(repo((m) => { m.patches = { 'dsh-c@2.0.1': { file: 'profile/patches/e.patch', note: 'n', issue: ISSUE } } })).status, 1)
})

test('check-manifest: a missing file, a file that is not a git diff, a missing issue or note all fail', () => {
  assert.match(check(repo(() => {}, { patch: null })).stderr, /missing file profile\/patches\/e\.patch/)
  assert.match(check(repo(() => {}, { patch: '<html>' })).stderr, /is not a git diff/)
  const noIssue = check(repo((m) => { delete m.patches['@kenz1117/dsh-engram@0.13.15'].issue; delete m.patches['@kenz1117/dsh-engram@0.13.15'].note }))
  assert.match(noIssue.stderr, /"issue" \(the upstream issue to follow\) is required/)
  assert.match(noIssue.stderr, /"note"/)
})

test('check-manifest: a plain string patch (no issue) is accepted by the CLI but rejected by the check', () => {
  const r = check(repo((m) => { m.patches = { '@kenz1117/dsh-engram@0.13.15': 'profile/patches/e.patch' } }))
  assert.equal(r.status, 1)
  assert.match(r.stderr, /"issue"/)
})

// ---- follow --------------------------------------------------------------------------------------------------------

test('patchConflicts: a new version of a patched package conflicts, the same version and other packages do not', () => {
  const m = manifest()
  const [c, ...rest] = patchConflicts(m, ['@kenz1117/dsh-engram@0.13.16', 'dsh-a@1.1.0', '@deepseek-ai/dsh@0.2.2-rc.6'])
  assert.equal(rest.length, 0)
  assert.equal(c.spec, '@kenz1117/dsh-engram@0.13.16')
  assert.equal(c.patchedVersion, '0.13.15')
  assert.match(c.message, /^patched package has a new version: @kenz1117\/dsh-engram 0\.13\.15 -> 0\.13\.16\./)
  assert.match(c.message, /re-check https:\/\/github\.com\/kenz1117\/dsh-engram\/issues\/64 and drop or regenerate the patch/)
  assert.deepEqual(patchConflicts(m, ['@kenz1117/dsh-engram@0.13.15']), [])
  assert.deepEqual(patchConflicts({ ...m, patches: undefined }, ['@kenz1117/dsh-engram@0.13.16']), [])
  // a plain-string patch entry works too
  assert.equal(patchConflicts(manifest({ 'dsh-a@1.0.0': 'a.patch' }), ['dsh-a@1.0.1']).length, 1)
})

test('screenPatched: the blocked candidate becomes a needs-human result of reason "patched", the rest is still tested', () => {
  const { testable, blocked } = screenPatched(manifest(), ['@kenz1117/dsh-engram@0.13.16', 'dsh-a@1.1.0'])
  assert.deepEqual(testable, ['dsh-a@1.1.0'])
  assert.equal(blocked.length, 1)
  assert.deepEqual({ ...blocked[0], message: undefined, tail: undefined }, { spec: '@kenz1117/dsh-engram@0.13.16', name: '@kenz1117/dsh-engram', version: '0.13.16', step: 'patched package', class: 'needs-human', reason: 'patched', message: undefined, tail: undefined })
  assert.ok(blocked[0].message.includes('patched package has a new version'))
  assert.deepEqual(screenPatched(manifest(), ['@kenz1117/dsh-engram@0.13.16']).testable, [])
})

test('a blocked candidate is merged as failed on every OS and never released', () => {
  const { blocked } = screenPatched(manifest(), ['@kenz1117/dsh-engram@0.13.16', 'dsh-a@1.1.0'])
  const run = (os) => ({ os, result: { passed: ['dsh-a@1.1.0'], failed: blocked } })
  const merged = mergeResults([run('ubuntu-latest'), run('macos-latest')])
  assert.deepEqual(merged.passed, ['dsh-a@1.1.0'])
  assert.equal(merged.failed.length, 1)
  assert.equal(merged.failed[0].reason, 'patched')
  assert.equal(merged.failed[0].class, 'needs-human')
})

test('the follow issue for a patched package says so, links the upstream issue and is not about install scripts', () => {
  const { blocked } = screenPatched(manifest(), ['@kenz1117/dsh-engram@0.13.16'])
  const plan = planIssueActions({ openIssues: [], passed: [], failed: blocked, pins: { '@kenz1117/dsh-engram': '0.13.15' }, runUrl: 'https://example/run/1' })
  assert.equal(plan.create.length, 1)
  assert.equal(plan.create[0].title, 'follow: @kenz1117/dsh-engram 0.13.16 does not pass')
  assert.match(plan.create[0].body, /A human has to look at this/)
  assert.match(plan.create[0].body, /patched package has a new version/)
  assert.match(plan.create[0].body, /issues\/64/)
  assert.ok(!plan.create[0].body.includes('install script'))
  // the install-script wording is unchanged for the other needs-human case
  assert.match(issueBody({ name: 'x', version: '1', class: 'needs-human', step: 's', tail: '' }), /install script/)
})

test('the issue is closed once the pin has moved past the blocked version (the patch was dropped by a human)', () => {
  const { blocked } = screenPatched(manifest(), ['@kenz1117/dsh-engram@0.13.16'])
  const open = [{ number: 7, title: 'follow: @kenz1117/dsh-engram 0.13.16 does not pass', labels: ['follow'] }]
  const still = planIssueActions({ openIssues: open, passed: [], failed: blocked, pins: { '@kenz1117/dsh-engram': '0.13.15' } })
  assert.equal(still.update.length, 1)
  assert.equal(still.close.length, 0)
  const done = planIssueActions({ openIssues: open, passed: [], failed: [], pins: { '@kenz1117/dsh-engram': '0.13.16' } })
  assert.deepEqual(done.close.map((c) => c.number), [7])
})
