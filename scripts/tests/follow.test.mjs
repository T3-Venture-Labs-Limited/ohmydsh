import assert from 'node:assert/strict'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { applyPins, applyReleaseNotes, bumpLine, changelogWith, externalPlugins, findCandidates, issuePackage, issueTitle, parseIssueTitle, pickVersion, splitSpec } from '../lib/follow.mjs'

const packument = (latest, versions, extra = {}) => ({ 'dist-tags': { latest, ...extra }, versions: Object.fromEntries(versions.map((v) => [v, {}])) })
const manifest = () => ({
  version: '0.1.3',
  dsh: '0.2.2-rc.3',
  plugins: {
    core: { 'dsh-a': '1.0.0', '@x/dsh-b': '0.5.0', '@t3labs/ohmydsh-own': '0.1.0' },
    packs: { p: { 'dsh-c': '2.0.0', '@t3labs/ohmydsh-own2': '0.1.0' } },
  },
  sources: { '@t3labs/ohmydsh-own': { workspace: 'packages/own' }, '@t3labs/ohmydsh-own2': { workspace: 'packages/own2' } },
})

test('externalPlugins skips everything we build ourselves, core and packs', () => {
  assert.deepEqual([...externalPlugins(manifest())].map(([n, v]) => [n, v.where]), [['dsh-a', 'core'], ['@x/dsh-b', 'core'], ['dsh-c', 'pack:p']])
})

test('pickVersion: latest tag only, no alpha, no downgrade, no stable -> prerelease', () => {
  assert.equal(pickVersion('0.2.2-rc.3', packument('0.2.2-rc.5', ['0.2.2-rc.3', '0.2.2-rc.5'], { alpha: '0.2.3-alpha.1' })), '0.2.2-rc.5')
  assert.equal(pickVersion('0.2.2-rc.5', packument('0.2.2-rc.3', [])), null, 'never a downgrade')
  assert.equal(pickVersion('0.2.2-rc.5', packument('0.2.2-rc.5', [])), null, 'same version')
  assert.equal(pickVersion('0.2.2-rc.3', packument('0.2.3-alpha.1', [])), null, 'alpha is ignored')
  assert.equal(pickVersion('1.0.0', packument('1.1.0-rc.1', [])), null, 'stable is not moved to a prerelease')
  assert.equal(pickVersion('0.2.2-rc.9', packument('0.2.2-rc.10', [])), '0.2.2-rc.10', 'rc.10 is newer than rc.9')
  assert.equal(pickVersion('0.2.2-rc.9', packument('0.2.2', [])), '0.2.2', 'the release follows its rc')
  assert.equal(pickVersion('1.0.0', packument(undefined, ['1.0.0', '1.2.0', '1.3.0-beta.1'])), '1.2.0', 'no latest tag: newest stable')
})

test('pickVersion: a minimum age skips a release that is too new', () => {
  const p = { ...packument('1.1.0', []), time: { '1.1.0': '2026-11-20T10:00:00Z' } }
  const now = Date.parse('2026-11-20T12:00:00Z')
  assert.equal(pickVersion('1.0.0', p, { minAgeHours: 6, now }), null)
  assert.equal(pickVersion('1.0.0', p, { minAgeHours: 1, now }), '1.1.0')
})

test('findCandidates: DSH first, plugins sorted, own packages never, hold/skip/only honoured', async () => {
  const data = {
    '@deepseek-ai/dsh': packument('0.2.2-rc.5', ['0.2.2-rc.3', '0.2.2-rc.5']),
    'dsh-a': packument('1.1.0', ['1.0.0', '1.1.0']),
    '@x/dsh-b': packument('0.5.0', ['0.5.0']),
    'dsh-c': packument('2.1.0', ['2.0.0', '2.1.0']),
  }
  const fetchPackument = async (n) => { if (!data[n]) throw new Error(`unexpected fetch of ${n}`); return data[n] }
  const all = await findCandidates(manifest(), { fetchPackument })
  assert.deepEqual(all.candidates.map((c) => `${c.name} ${c.from}->${c.to}`), ['@deepseek-ai/dsh 0.2.2-rc.3->0.2.2-rc.5', 'dsh-a 1.0.0->1.1.0', 'dsh-c 2.0.0->2.1.0'])
  assert.equal(all.candidates[0].kind, 'dsh')

  const held = await findCandidates(manifest(), { fetchPackument, hold: ['dsh-a'], skip: ['dsh-c@2.1.0'] })
  assert.deepEqual(held.candidates.map((c) => c.name), ['@deepseek-ai/dsh'])
  assert.deepEqual(held.held.map((c) => c.name), ['dsh-a'])
  assert.deepEqual(held.skipped.map((c) => c.name), ['dsh-c'])

  const only = await findCandidates(manifest(), { fetchPackument, only: 'dsh-c@2.1.0', hold: ['dsh-c'], skip: ['dsh-c@2.1.0'] })
  assert.deepEqual(only.candidates.map((c) => c.name), ['dsh-c'], 'only ignores hold and skip')
  const missing = await findCandidates(manifest(), { fetchPackument, only: 'dsh-c@9.9.9' })
  assert.equal(missing.candidates.length, 0)
  assert.match(missing.errors[0], /not on npm/)
})

test('findCandidates reports a registry error for one package and still returns the rest', async () => {
  const fetchPackument = async (n) => { if (n === 'dsh-a') throw new Error('HTTP 503'); return packument('0.0.1', ['0.0.1']) }
  const r = await findCandidates(manifest(), { fetchPackument })
  assert.deepEqual(r.errors, ['dsh-a: HTTP 503'])
})

function checkout() {
  const root = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'follow-'))
  writeFileSync(join(root, 'ohmydsh.json'), `${JSON.stringify(manifest(), null, 2)}\n`)
  mkdirSync(join(root, 'packages', 'cli'), { recursive: true })
  mkdirSync(join(root, 'packages', 'own'), { recursive: true })
  mkdirSync(join(root, 'apps', 'desktop', 'tests', 'smoke'), { recursive: true })
  mkdirSync(join(root, 'docs'), { recursive: true })
  writeFileSync(join(root, 'packages', 'cli', 'package.json'), `${JSON.stringify({ name: '@t3labs/ohmydsh', version: '0.1.3' }, null, 2)}\n`)
  writeFileSync(join(root, 'packages', 'own', 'package.json'), `${JSON.stringify({ name: '@t3labs/ohmydsh-own', version: '0.1.0', devDependencies: { '@deepseek-ai/dsh-llm': '0.2.2-rc.3', '@deepseek-ai/cordis': '4.1.0' }, peerDependencies: { '@deepseek-ai/dsh-llm': '>=0.2.2-rc.1 <0.3.0-0' } }, null, 2)}\n`)
  writeFileSync(join(root, 'apps', 'desktop', 'package.json'), `${JSON.stringify({ name: '@ohmydsh/desktop', version: '0.1.3' }, null, 2)}\n`)
  writeFileSync(join(root, 'apps', 'desktop', 'tests', 'smoke', 'ohmydsh.json'), '{\n  "version": "0.0.0-smoke",\n  "dsh": "0.2.2-rc.3"\n}\n')
  writeFileSync(join(root, 'docs', 'DESIGN.md'), '```json\n  "dsh": "0.2.2-rc.3",                // exact\n```\n')
  writeFileSync(join(root, 'README.md'), '<img alt="DeepSeek Harness 0.2.2-rc.3" src="https://img.shields.io/badge/dsh-0.2.2--rc.3-2447D6">\n')
  writeFileSync(join(root, 'pnpm-workspace.yaml'), "minimumReleaseAgeExclude:\n  - '@deepseek-ai/dsh-llm@0.2.2-rc.3'\n")
  writeFileSync(join(root, 'CHANGELOG.md'), '# Changelog\n\nintro\n\n## 0.1.3\n\n- old\n\n## 0.1.2\n\n- older\n')
  return root
}
const read = (root, f) => readFileSync(join(root, f), 'utf8')

test('applyPins pins a plugin everywhere it appears and leaves the file format alone', () => {
  const root = checkout()
  const r = applyPins(root, ['dsh-a@1.1.0', 'dsh-c@2.1.0'])
  assert.deepEqual(r.bumps.map((b) => `${b.name} ${b.from}->${b.to}`), ['dsh-a 1.0.0->1.1.0', 'dsh-c 2.0.0->2.1.0'])
  const m = JSON.parse(read(root, 'ohmydsh.json'))
  assert.equal(m.plugins.core['dsh-a'], '1.1.0')
  assert.equal(m.plugins.packs.p['dsh-c'], '2.1.0')
  assert.equal(m.dsh, '0.2.2-rc.3')
  assert.equal(read(root, 'ohmydsh.json'), `${JSON.stringify(m, null, 2)}\n`)
})

test('applyPins refuses our own packages and unknown plugins', () => {
  const root = checkout()
  assert.throws(() => applyPins(root, ['@t3labs/ohmydsh-own@0.2.0']), /built from this repo/)
  assert.throws(() => applyPins(root, ['nope@1.0.0']), /not a plugin/)
  assert.throws(() => splitSpec('dsh-a'), /name@version/)
  assert.throws(() => splitSpec('dsh-a@^1.0.0'), /exact version/)
})

test('applyPins for DSH rewrites the manifest and every duplicated pin (packages, smoke manifest, docs, badge, pnpm workspace)', () => {
  const root = checkout()
  const r = applyPins(root, ['@deepseek-ai/dsh@0.2.2-rc.5'])
  assert.deepEqual(r.bumps, [{ name: '@deepseek-ai/dsh', kind: 'dsh', from: '0.2.2-rc.3', to: '0.2.2-rc.5' }])
  assert.equal(JSON.parse(read(root, 'ohmydsh.json')).dsh, '0.2.2-rc.5')
  const own = JSON.parse(read(root, 'packages/own/package.json'))
  assert.equal(own.devDependencies['@deepseek-ai/dsh-llm'], '0.2.2-rc.5')
  assert.equal(own.devDependencies['@deepseek-ai/cordis'], '4.1.0', 'unrelated @deepseek-ai pins are not touched')
  assert.equal(own.peerDependencies['@deepseek-ai/dsh-llm'], '>=0.2.2-rc.1 <0.3.0-0', 'peer ranges are not touched')
  assert.match(read(root, 'apps/desktop/tests/smoke/ohmydsh.json'), /"dsh": "0\.2\.2-rc\.5"/)
  assert.match(read(root, 'docs/DESIGN.md'), /"dsh": "0\.2\.2-rc\.5"/)
  assert.match(read(root, 'README.md'), /DeepSeek Harness 0\.2\.2-rc\.5.*dsh-0\.2\.2--rc\.5-2447D6/)
  assert.match(read(root, 'pnpm-workspace.yaml'), /dsh-llm@0\.2\.2-rc\.5/)
  for (const f of ['packages/own/package.json', 'README.md', 'pnpm-workspace.yaml', 'apps/desktop/tests/smoke/ohmydsh.json', 'docs/DESIGN.md']) assert.ok(r.files.includes(f), f)
})

test('bumpLine and changelogWith: a new section above the previous release, links to npm', () => {
  const bumps = [{ name: '@deepseek-ai/dsh', kind: 'dsh', from: '0.2.2-rc.3', to: '0.2.2-rc.5' }, { name: '@kenz1117/dsh-engram', kind: 'plugin', from: '0.13.10', to: '0.13.15' }]
  assert.equal(bumpLine(bumps[1]), '- @kenz1117/dsh-engram 0.13.10 -> 0.13.15 ([npm](https://www.npmjs.com/package/@kenz1117/dsh-engram/v/0.13.15))')
  assert.match(bumpLine(bumps[0]), /^- DeepSeek Harness 0\.2\.2-rc\.3 -> 0\.2\.2-rc\.5 \(\[npm\]\(https:\/\/www\.npmjs\.com\/package\/@deepseek-ai\/dsh\/v\/0\.2\.2-rc\.5\)\)$/)
  const out = changelogWith('# Changelog\n\nintro\n\n## 0.1.3\n\n- old\n', '0.1.4', bumps)
  assert.ok(out.indexOf('## 0.1.4') < out.indexOf('## 0.1.3'))
  assert.match(out, /Tested with DeepSeek Harness 0\.2\.2-rc\.5\./)
  assert.match(out, /intro\n\n## 0\.1\.4/)
})

test('changelogWith turns "## Unreleased" into the release section and keeps its bullets', () => {
  const text = '# Changelog\n\nintro\n\n## Unreleased\n\n- Desktop: something\n\n## 0.1.3\n\n- old\n'
  const out = changelogWith(text, '0.1.4', [{ name: 'dsh-a', kind: 'plugin', from: '1.0.0', to: '1.1.0' }])
  assert.doesNotMatch(out, /Unreleased/)
  assert.match(out, /## 0\.1\.4\n\n- Desktop: something\n\n### Followed upstream\n\n- dsh-a 1\.0\.0 -> 1\.1\.0/)
  assert.ok(out.indexOf('## 0.1.4') < out.indexOf('## 0.1.3'))
})

test('applyReleaseNotes bumps ohmydsh.json, the CLI and the desktop app to the same patch version and writes the section', () => {
  const root = checkout()
  const bumps = [{ name: 'dsh-a', kind: 'plugin', from: '1.0.0', to: '1.1.0' }]
  const files = applyReleaseNotes(root, bumps, '0.1.4')
  assert.deepEqual(files.sort(), ['CHANGELOG.md', 'apps/desktop/package.json', 'ohmydsh.json', 'packages/cli/package.json'])
  for (const f of ['ohmydsh.json', 'packages/cli/package.json', 'apps/desktop/package.json']) assert.equal(JSON.parse(read(root, f)).version, '0.1.4', f)
  assert.match(read(root, 'CHANGELOG.md'), /## 0\.1\.4\n[\s\S]*dsh-a 1\.0\.0 -> 1\.1\.0[\s\S]*## 0\.1\.3/)
})

test('issue titles round-trip and a hold is read from the package name', () => {
  assert.equal(issueTitle('dsh-a', '1.1.0'), 'follow: dsh-a 1.1.0 does not pass')
  assert.deepEqual(parseIssueTitle('follow: @x/dsh-b 0.6.0 does not pass'), { name: '@x/dsh-b', version: '0.6.0' })
  assert.equal(parseIssueTitle('something else'), null)
  assert.equal(issuePackage('follow: dsh-a hold until the fix lands'), 'dsh-a')
})
