import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { applicablePatches, defaultManifestSource, parseManifest, patchFileName, registryPins, resolveDesired, specFor } from '../src/manifest.js'
import { baseManifest, tmp } from './helpers.js'

test('parses a valid manifest and fills defaults', () => {
  const m = parseManifest(JSON.stringify(baseManifest()))
  assert.equal(m.node, '>=24')
  assert.deepEqual(m.allowBuilds, [])
  assert.equal(m.profile.name, 'omd')
})

test('the real ohmydsh.json in this repo is valid and fully pinned', async () => {
  const { readFile } = await import('node:fs/promises')
  const m = parseManifest(await readFile(new URL('../../../ohmydsh.json', import.meta.url), 'utf8'))
  assert.match(m.dsh, /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/) // the pin moves with every follow release
  for (const core of ['studio', 'pwa', 'browser-takeover', 'review-comments', 'skill-studio', 'notebook', 'triggers', 'automation-models'].map((n) => `@t3labs/ohmydsh-${n}`)) assert.ok(m.plugins.core[core], core)
  assert.deepEqual(Object.keys(m.plugins.packs).sort(), ['composio', 'langfuse', 'omarchy', 'parallel'])
  // Release shape: every one of our plugins resolves from the registry (no tarball URLs left in the manifest).
  for (const [name, s] of Object.entries(m.sources)) assert.equal(s.tarball, undefined, `${name} still has a tarball URL`)
  const { plugins } = resolveDesired(m, { packs: Object.keys(m.plugins.packs), source: '/x/ohmydsh.json' })
  for (const [name, p] of plugins) assert.equal(p.spec, p.version, `${name} should install from npm`)
})

test('rejects ranges, missing dsh pin and unknown sources, listing every problem', () => {
  const bad = baseManifest()
  bad.plugins.core['dsh-a'] = '^1.0.0'
  delete bad.dsh
  bad.sources.ghost = { tarball: 'https://x.invalid/g.tgz' }
  assert.throws(() => parseManifest(JSON.stringify(bad)), (e) => /dsh must be an exact version/.test(e.message) && /not an exact version/.test(e.message) && /ghost is not a plugin/.test(e.message))
})

test('rejects http tarballs and malformed allowBuilds', () => {
  const bad = baseManifest()
  bad.sources['@ohmydsh/b'].tarball = 'http://insecure.invalid/b.tgz'
  bad.allowBuilds = ['agent-browser']
  assert.throws(() => parseManifest(JSON.stringify(bad)), (e) => /https URL/.test(e.message) && /allowBuilds/.test(e.message))
})

test('rejects invalid JSON', () => {
  assert.throws(() => parseManifest('{nope'), /not valid JSON/)
})

test('resolveDesired: core plus requested packs; unknown pack is an error', () => {
  const m = parseManifest(JSON.stringify(baseManifest()))
  const { plugins } = resolveDesired(m, { packs: [], source: '/x/ohmydsh.json' })
  assert.deepEqual([...plugins.keys()], ['dsh-a', '@ohmydsh/b'])
  assert.equal(plugins.get('dsh-a').spec, '1.0.0')
  assert.equal(plugins.get('@ohmydsh/b').spec, '0.1.0', 'ours install from the registry at the pinned version')
  const withPack = resolveDesired(m, { packs: ['extra'], source: '/x/ohmydsh.json' })
  assert.deepEqual(withPack.plugins.get('dsh-c').origin, ['pack:extra'])
  assert.throws(() => resolveDesired(m, { packs: ['nope'], source: '/x' }), /unknown pack "nope"/)
})

test('--dev links the workspace folder of our packages and needs a local checkout', () => {
  const root = tmp()
  mkdirSync(join(root, 'packages/b'), { recursive: true })
  writeFileSync(join(root, 'packages/b/package.json'), '{}')
  const m = parseManifest(JSON.stringify(baseManifest()))
  assert.equal(specFor(m, '@ohmydsh/b', '0.1.0', { dev: true, source: join(root, 'ohmydsh.json') }), `link:${join(root, 'packages/b')}`)
  assert.equal(specFor(m, 'dsh-a', '1.0.0', { dev: true, source: join(root, 'ohmydsh.json') }), '1.0.0')
  assert.throws(() => specFor(m, '@ohmydsh/b', '0.1.0', { dev: true, source: 'https://x.invalid/ohmydsh.json' }), /local manifest/)
})

test('defaultManifestSource precedence: flag, env, checkout, published', () => {
  assert.equal(defaultManifestSource({ flag: '/a/m.json', env: { OMD_MANIFEST: '/b/m.json' } }), '/a/m.json')
  assert.equal(defaultManifestSource({ env: { OMD_MANIFEST: 'https://x.invalid/m.json' } }), 'https://x.invalid/m.json')
  assert.match(defaultManifestSource({ env: {}, cliDir: '/nonexistent/a/b' }), /^https:\/\/raw\.githubusercontent\.com\//)
})

test('a source tarball is an escape hatch: https URL as is, a relative path resolved next to the manifest', () => {
  const remote = baseManifest()
  remote.sources['@ohmydsh/b'] = { workspace: 'packages/b', tarball: 'https://example.invalid/b-0.1.0.tgz' }
  assert.equal(specFor(parseManifest(JSON.stringify(remote)), '@ohmydsh/b', '0.1.0', { source: '/x/ohmydsh.json' }), 'https://example.invalid/b-0.1.0.tgz')
  const local = baseManifest()
  local.sources['@ohmydsh/b'] = { tarball: './tarballs/b-0.1.0.tgz' }
  const lm = parseManifest(JSON.stringify(local))
  assert.equal(specFor(lm, '@ohmydsh/b', '0.1.0', { source: '/x/ohmydsh.json' }), 'file:/x/tarballs/b-0.1.0.tgz')
  assert.throws(() => specFor(lm, '@ohmydsh/b', '0.1.0', { source: 'https://x.invalid/ohmydsh.json' }), /local manifest/)
  assert.throws(() => specFor(lm, '@ohmydsh/b', '0.1.0', { dev: true, source: '/x/ohmydsh.json' }), /no workspace folder/)
})

test('registryPins lists only plugins resolved from the registry', () => {
  const local = baseManifest()
  local.sources['@ohmydsh/b'] = { tarball: './b.tgz' }
  const lm = parseManifest(JSON.stringify(local))
  const { plugins } = resolveDesired(lm, { source: '/x/ohmydsh.json' })
  assert.deepEqual(registryPins(lm, plugins), ['dsh-a@1.0.0'])
})

test('release-age exemptions keep what omd installed last time (two releases within 24 h)', async () => {
  const { releaseAgeExemptions } = await import('../src/manifest.js')
  const desired = new Map([['a', { version: '1.0.1', spec: '1.0.1' }], ['ours', { version: '0.2.0', spec: 'link:/x' }]])
  const lock = { plugins: { a: { version: '1.0.0', spec: '1.0.0' }, theme: { version: '0.1.3', spec: '0.1.3' }, dev: { version: '0.1.0', spec: 'link:/y' } } }
  assert.deepEqual(releaseAgeExemptions({}, desired, lock), ['a@1.0.0', 'a@1.0.1', 'theme@0.1.3'])
  assert.deepEqual(releaseAgeExemptions({}, desired, null), ['a@1.0.1'])
})

const withPatches = (patches) => parseManifest(JSON.stringify({ ...baseManifest(), patches }))

test('patches: a string or an object with file/note/issue, normalized to the object form', () => {
  const m = withPatches({ 'dsh-a@1.0.0': 'profile/patches/a.patch', '@ohmydsh/x@2.0.0-rc.1': { file: 'p/x.patch', note: 'does x', issue: 'https://github.com/o/r/issues/1' } })
  assert.deepEqual(m.patches['dsh-a@1.0.0'], { file: 'profile/patches/a.patch' })
  assert.deepEqual(m.patches['@ohmydsh/x@2.0.0-rc.1'], { file: 'p/x.patch', note: 'does x', issue: 'https://github.com/o/r/issues/1' })
  assert.deepEqual(parseManifest(JSON.stringify(baseManifest())).patches, {}, 'no patches is the default')
})

test('patches: only exact name@version keys, a file, an https issue; every problem listed', () => {
  assert.throws(() => withPatches({ 'dsh-a': 'a.patch', 'dsh-a@^1.0.0': 'a.patch', 'dsh-a@1.0.0': '', 'dsh-c@2.0.0': { file: 'c.patch', issue: 'http://x/1' } }), (e) => /patches\.dsh-a: the key must be name@exact-version/.test(e.message) && /patches\.dsh-a@\^1\.0\.0/.test(e.message) && /patches\.dsh-a@1\.0\.0: needs a patch file/.test(e.message) && /patches\.dsh-c@2\.0\.0\.issue must be an https URL/.test(e.message))
  assert.throws(() => withPatches(['x']), /patches must be an object/)
})

test('applicablePatches: only a plugin in the set at exactly the patched version (pnpm fails on an unused patch)', () => {
  const m = withPatches({ 'dsh-a@1.0.0': 'a.patch', 'dsh-c@2.0.0': 'c.patch', 'dsh-a@0.9.0': 'old.patch', 'dsh-gone@1.0.0': 'g.patch' })
  const core = resolveDesired(m, { packs: [], source: '/x/ohmydsh.json' }).plugins
  assert.deepEqual(applicablePatches(m, core).map((p) => p.key), ['dsh-a@1.0.0'], 'dsh-c is in a pack that is off, dsh-a@0.9.0 and dsh-gone are not the pinned ones')
  const withPack = resolveDesired(m, { packs: ['extra'], source: '/x/ohmydsh.json' }).plugins
  assert.deepEqual(applicablePatches(m, withPack).map((p) => p.key), ['dsh-a@1.0.0', 'dsh-c@2.0.0'])
  // another pinned version of the patched plugin: nothing applies, so nothing may be written for pnpm
  const moved = parseManifest(JSON.stringify({ ...baseManifest(), plugins: { core: { 'dsh-a': '1.0.1' }, packs: {} }, sources: {}, patches: { 'dsh-a@1.0.0': 'a.patch' } }))
  assert.deepEqual(applicablePatches(moved, resolveDesired(moved, { source: '/x/ohmydsh.json' }).plugins), [])
})

test('applicablePatches skips a linked plugin (--dev), the patch would be unused', () => {
  const m = parseManifest(JSON.stringify({ ...baseManifest(), patches: { '@ohmydsh/b@0.1.0': 'b.patch' } }))
  const dir = tmp()
  mkdirSync(join(dir, 'packages/b'), { recursive: true })
  writeFileSync(join(dir, 'packages/b/package.json'), '{}')
  const dev = resolveDesired(m, { dev: true, source: join(dir, 'ohmydsh.json') }).plugins
  assert.equal(dev.get('@ohmydsh/b').spec.startsWith('link:'), true)
  assert.deepEqual(applicablePatches(m, dev), [])
  assert.deepEqual(applicablePatches(m, resolveDesired(m, { source: join(dir, 'ohmydsh.json') }).plugins).map((p) => p.key), ['@ohmydsh/b@0.1.0'])
})

test('patchFileName comes from the key: scoped names are flattened, nothing from the manifest path', () => {
  assert.equal(patchFileName('@kenz1117/dsh-engram@0.13.15'), '@kenz1117__dsh-engram@0.13.15.patch')
  assert.equal(patchFileName('dsh-a@1.0.0'), 'dsh-a@1.0.0.patch')
})
