import assert from 'node:assert/strict'
import { test } from 'node:test'
import { END, hasBlock, readBlock, removeBlock, rewriteBlock, rewriteWorkspaceYaml, rowIds } from '../src/managed.js'

const USER = `# my own rows
- id: web
  name: '@deepseek-ai/dsh-web'
  config:
    searchProvider: brave
`

test('first rewrite puts the block above the user rows and leaves them byte for byte', () => {
  const out = rewriteBlock(USER, '- id: studio\n  name: dsh-studio\n')
  assert.ok(out.startsWith('# >>> ohmydsh'))
  assert.ok(out.endsWith(USER))
  assert.equal(hasBlock(out), true)
  assert.equal(readBlock(out).trim(), '- id: studio\n  name: dsh-studio')
})

test('a later rewrite replaces only the block; edits inside it are dropped, user rows survive', () => {
  const first = rewriteBlock(USER, '- id: studio\n  name: dsh-studio\n')
  const edited = first.replace('name: dsh-studio', 'name: tampered')
  const second = rewriteBlock(edited, '- id: dsh-pwa\n  name: dsh-pwa\n')
  assert.ok(!second.includes('tampered'))
  assert.ok(!second.includes('dsh-studio'))
  assert.ok(second.endsWith(USER))
  assert.equal(second.split('# >>> ohmydsh').length, 2)
})

test('rewriting is idempotent', () => {
  const a = rewriteBlock(USER, '- id: x\n  name: y\n')
  assert.equal(rewriteBlock(a, '- id: x\n  name: y\n'), a)
})

test('user text above and below the block both survive', () => {
  const text = `# top\n- id: a\n  name: a\n\n# >>> ohmydsh\nold\n${END}\n\n# bottom\n- id: b\n  name: b\n`
  const out = rewriteBlock(text, '- id: n\n  name: n\n')
  assert.ok(out.startsWith('# top\n- id: a'))
  assert.ok(out.includes('# bottom\n- id: b'))
  assert.ok(!out.includes('old'))
})

test('an empty patch file stays valid YAML: [] when nothing is left, no [] when rows exist', () => {
  const empty = rewriteBlock('# comments only\n[]\n', '')
  assert.ok(empty.trimEnd().endsWith('[]'))
  const filled = rewriteBlock('# comments only\n[]\n', '- id: x\n  name: y\n')
  assert.ok(!/^\[\]$/m.test(filled))
  const removed = removeBlock(filled)
  assert.ok(/^\[\]$/m.test(removed))
  assert.equal(hasBlock(removed), false)
})

test('damaged markers are refused instead of guessed at', () => {
  assert.throws(() => rewriteBlock('# >>> ohmydsh\nrows\n', '- id: x\n'), /markers are damaged/)
  assert.throws(() => rewriteBlock(`${END}\n# >>> ohmydsh\n`, '- id: x\n'), /markers are damaged/)
})

test('rowIds finds top-level rows and inserted rows', () => {
  assert.deepEqual(rowIds('- insert:\n    - id: a-b\n      name: x\n- id: "c"\n  name: y\n'), ['a-b', 'c'])
})

test('rowIds skips ids nested inside a row (a provider\'s model list is not a row)', () => {
  const patch = '- id: llm-pi-ai\n  config:\n    providers:\n      - name: x\n        models:\n          - id: claude-haiku-5-5\n          - id: kimi-k3\n- id: agent-default-model\n  config: {}\n- insert:\n    - id: added\n      config:\n        list:\n          - id: deep\n'
  assert.deepEqual(rowIds(patch), ['llm-pi-ai', 'agent-default-model', 'added'])
})

test('workspace yaml: our block carries allowBuilds and release-age pins; user keys win', () => {
  const r = rewriteWorkspaceYaml('packages:\n  - .\n', { allowBuilds: ['agent-browser@0.43.0'], releaseAgeExclude: ['dsh-x@1.0.0'] })
  assert.match(r.text, /allowBuilds:\n {2}agent-browser@0\.43\.0: true/)
  assert.match(r.text, /- 'dsh-x@1\.0\.0'/)
  assert.deepEqual(r.warnings, [])
  const mine = rewriteWorkspaceYaml('packages:\n  - .\nallowBuilds:\n  esbuild: true\n', { allowBuilds: ['agent-browser@0.43.0'], releaseAgeExclude: [] })
  assert.ok(!mine.text.includes('agent-browser@0.43.0: true'))
  assert.equal(mine.warnings.length, 1)
  assert.ok(mine.text.includes('allowBuilds:\n  esbuild: true'))
})

test('rewriteWorkspaceYaml writes patchedDependencies into the block and reports which keys it wrote', () => {
  const base = { allowBuilds: [], releaseAgeExclude: [] }
  const patchedDependencies = { '@kenz1117/dsh-engram@0.13.15': 'patches/ohmydsh/@kenz1117__dsh-engram@0.13.15.patch' }
  const r = rewriteWorkspaceYaml('packages:\n  - .\nnodeLinker: hoisted\n', { ...base, patchedDependencies })
  assert.match(r.text, /patchedDependencies:\n {2}'@kenz1117\/dsh-engram@0\.13\.15': 'patches\/ohmydsh\/@kenz1117__dsh-engram@0\.13\.15\.patch'/)
  assert.deepEqual(r.patched, ['@kenz1117/dsh-engram@0.13.15'])
  assert.deepEqual(r.warnings, [])
  assert.ok(r.text.includes('nodeLinker: hoisted'))
  // dropping the patch removes the key again, and the rest of the file is untouched
  const dropped = rewriteWorkspaceYaml(r.text, { ...base })
  assert.ok(!dropped.text.includes('patchedDependencies'))
  assert.deepEqual(dropped.patched, [])
  assert.ok(dropped.text.endsWith('packages:\n  - .\nnodeLinker: hoisted\n'))
})

test('rewriteWorkspaceYaml leaves a patchedDependencies the user wrote alone and says so', () => {
  const user = 'packages:\n  - .\npatchedDependencies:\n  mine@1.0.0: patches/mine.patch\n'
  const r = rewriteWorkspaceYaml(user, { allowBuilds: [], releaseAgeExclude: [], patchedDependencies: { 'dsh-a@1.0.0': 'patches/ohmydsh/dsh-a@1.0.0.patch' } })
  assert.deepEqual(r.patched, [])
  assert.match(r.warnings.join('\n'), /already has its own patchedDependencies/)
  assert.ok(r.text.includes('mine@1.0.0: patches/mine.patch'))
  assert.ok(!r.text.includes('dsh-a@1.0.0'))
})
