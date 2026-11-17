import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { defaultManifestSource, parseManifest, resolveDesired, specFor } from '../src/manifest.js'
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
  assert.equal(m.dsh, '0.2.2-rc.3')
  for (const core of ['dsh-studio', 'dsh-pwa', 'dsh-agent-browser-takeover', 'dsh-review-comments', 'dsh-skill-studio', 'dsh-notebook', 'dsh-triggers', 'dsh-automation-models']) assert.ok(m.plugins.core[core], core)
  assert.deepEqual(Object.keys(m.plugins.packs).sort(), ['composio', 'langfuse', 'omarchy', 'parallel'])
})

test('rejects ranges, missing dsh pin and unknown sources, listing every problem', () => {
  const bad = baseManifest()
  bad.plugins.core['dsh-a'] = '^1.0.0'
  delete bad.dsh
  bad.sources.ghost = { tarball: 'https://x.invalid/g.tgz' }
  assert.throws(() => parseManifest(JSON.stringify(bad)), (e) => /dsh must be an exact version/.test(e.message) && /not an exact version/.test(e.message) && /ghost is not a plugin/.test(e.message))
})

test('rejects non-https tarballs and malformed allowBuilds', () => {
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
  assert.equal(plugins.get('@ohmydsh/b').spec, 'https://example.invalid/b-0.1.0.tgz')
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
