import assert from 'node:assert/strict'
import { test } from 'node:test'
import { composeCheck, describeCompose, dumpedBundles, parseProblems, parseUnapplied } from '../src/health.js'

const DUMP = `# == @deepseek-ai/dsh-base
- id: llm
# == dsh-studio, patched by /x/profiles/omd/cordis.patch.yml
- id: studio
  name: dsh-studio
# == dsh-pwa
- id: dsh-pwa
`

test('unapplied rows are detected from dsh warnings', () => {
  const err = 'dsh: [/p/cordis.patch.yml] patch: entry "ghost" not found\ndsh: [/p/cordis.patch.yml] patch: entry "other" not found\n'
  assert.deepEqual(parseUnapplied(err), ['ghost', 'other'])
  assert.deepEqual(parseUnapplied(''), [])
  assert.deepEqual(parseProblems(err), [])
  assert.deepEqual(parseProblems('Error: something invalid happened\n'), ['Error: something invalid happened'])
})

test('bundle headers are read with their "patched by" suffix stripped', () => {
  assert.deepEqual([...dumpedBundles(DUMP)].sort(), ['@deepseek-ai/dsh-base', 'dsh-pwa', 'dsh-studio'])
})

const ctxWith = (r) => ({ env: {}, run: () => r })

test('composeCheck: clean, then unapplied row, missing plugin, missing managed row', () => {
  const ok = composeCheck(ctxWith({ status: 0, stdout: DUMP, stderr: '' }), { profile: 'p', plugins: ['dsh-studio', 'dsh-pwa'], managedYaml: '- id: studio\n  name: dsh-studio\n- id: dsh-pwa\n  name: dsh-pwa\n' })
  assert.equal(ok.ok, true)
  const bad = composeCheck(ctxWith({ status: 0, stdout: DUMP, stderr: 'patch: entry "ghost" not found\n' }), { profile: 'p', plugins: ['dsh-studio', 'dsh-missing'], managedYaml: '- id: nope\n  name: x\n' })
  assert.equal(bad.ok, false)
  assert.deepEqual(bad.unapplied, ['ghost'])
  assert.deepEqual(bad.missingBundles, ['dsh-missing'])
  assert.deepEqual(bad.missingRows, ['nope'])
  assert.equal(describeCompose(bad).length, 3)
})

test('composeCheck: a failing dsh is a failure, not a pass', () => {
  const r = composeCheck(ctxWith({ status: 1, stdout: '', stderr: 'boom\n' }), { profile: 'p', plugins: [] })
  assert.equal(r.ok, false)
  assert.match(r.errors[0], /exited 1/)
  const missing = composeCheck(ctxWith({ status: null, stdout: '', stderr: '', error: new Error('ENOENT') }), { profile: 'p', plugins: [] })
  assert.match(missing.errors[0], /could not run dsh/)
})
