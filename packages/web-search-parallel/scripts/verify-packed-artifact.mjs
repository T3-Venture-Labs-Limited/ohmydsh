import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'

const tarballIndex = process.argv.indexOf('--tarball')
assert.notEqual(tarballIndex, -1, 'usage: verify-packed-artifact.mjs --tarball <path>')
const tarball = resolve(process.argv[tarballIndex + 1])

function tar(args) {
  const result = spawnSync('tar', args, { encoding: 'utf8' })
  if (result.status !== 0) {
    process.stderr.write(result.stderr)
    process.exit(result.status ?? 1)
  }
  return result.stdout
}

const entries = tar(['-tzf', tarball])
  .split('\n')
  .filter(Boolean)
  .filter(entry => !entry.endsWith('/'))
  .sort()

assert.deepEqual(entries, [
  'package/CONTRIBUTING.md',
  'package/LICENSE',
  'package/README.md',
  'package/SECURITY.md',
  'package/cordis.patch.yml',
  'package/lib/index.d.ts',
  'package/lib/index.js',
  'package/package.json',
])

const manifest = JSON.parse(tar(['-xOzf', tarball, 'package/package.json']))
assert.equal(manifest.name, '@parallel-web/dsh-web-search-parallel')
assert.equal(manifest.version, '0.1.0')
assert.equal(manifest.author, 'Parallel <support@parallel.ai>')
assert.deepEqual(manifest.repository, {
  type: 'git',
  url: 'github:parallel-web/dsh-web-search-parallel',
})
assert.equal(manifest.dsh?.bundle?.patch, './cordis.patch.yml')
assert.equal(manifest.dependencies['parallel-web'], '1.3.0')
assert.equal(manifest.peerDependencies['@deepseek-ai/dsh-web'], '0.1.0-rc.6')

const combinedPublicText = entries
  .filter(entry => /\.(?:js|d\.ts|md|yml|json)$/.test(entry))
  .map(entry => tar(['-xOzf', tarball, entry]))
  .join('\n')

for (const forbidden of [
  `/${'Users'}/`,
  ['developer', 'parallel', 'code'].join('/'),
  `${'shapley'}/`,
  ['6e35a6c4c624a9e55a6121bbcef72', 'dd2748dec2c'].join(''),
  `${'.agent'}/`,
  ['.pre-commit', 'config.yaml'].join('-'),
  ['dirty', 'worktree'].join(' '),
  ['soft', 'launch'].join('-'),
]) {
  assert.equal(combinedPublicText.includes(forbidden), false, `packed artifact contains forbidden text: ${forbidden}`)
}

assert.equal(combinedPublicText.includes('registerFetchProvider'), false)
assert.equal(combinedPublicText.includes('PARALLEL_BASE_URL'), true, 'README must document that PARALLEL_BASE_URL is ignored')
process.stdout.write(`packed artifact valid: ${tarball}\n`)
