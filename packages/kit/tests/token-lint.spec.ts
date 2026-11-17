// @vitest-environment node
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const lint = resolve(import.meta.dirname, '../lint/token-lint.mjs')
let dir = ''
beforeEach(() => {
  const base = resolve(import.meta.dirname, '../.tmp')
  mkdirSync(base, { recursive: true })
  dir = mkdtempSync(join(base, 'lint-'))
  mkdirSync(join(dir, 'src'))
})
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

function run(files: Record<string, string>, extra: string[] = []) {
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(join(dir, name, '..'), { recursive: true })
    writeFileSync(join(dir, name), text)
  }
  return spawnSync('node', [lint, ...extra], { cwd: dir, encoding: 'utf8' })
}

describe('token-lint', () => {
  it('passes defined tokens', () => {
    const r = run({ 'src/a.css': '.a { color: var(--dsw-alias-label-primary); }' })
    expect(r.status).toBe(0)
  })
  it('fails undefined --dsw tokens (the invented-name defect)', () => {
    const r = run({ 'src/a.css': '.a { color: var(--dsw-alias-text-primary, #ddd); }' })
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('unknown-token')
    expect(r.stderr).toContain('--dsw-alias-text-primary')
  })
  it('fails hex and rgb literals outside artwork', () => {
    const r = run({ 'src/a.tsx': 'const a = "#ff0000"; const b = "rgba(0,0,0,.5)"' })
    expect(r.status).toBe(1)
    expect(r.stderr.match(/literal-colour/g)?.length).toBe(2)
  })
  it('fails dynamic token names', () => {
    const r = run({ 'src/a.ts': 'const x = `var(--dsw-alias-${name})`' })
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('dynamic-token')
  })
  it('allows colours in artwork paths, markers and comments', () => {
    const r = run({
      'src/artwork/logo.tsx': 'export const c = "#123456"',
      'src/b.ts': '// artwork:start\nconst c = "#abcdef"\n// artwork:end\nconst d = "#000000" // artwork:ok\n/* #fff in a comment */\n// "#eee" comment',
    })
    expect(r.status).toBe(0)
  })
  it('does not flag url fragments or ids that look like hex', () => {
    const r = run({ 'src/a.ts': 'const u = "https://x.test/page#section"; const id = "#abcdefghij"' })
    expect(r.status).toBe(0)
  })
  it('tokens-only mode for lib/ and disable-line', () => {
    mkdirSync(join(dir, 'lib'))
    const r = run({ 'lib/client.js': 'const c = "#fff"; var x = "--dsw-nope" // token-lint-disable-line' })
    expect(r.status).toBe(0)
    const r2 = run({ 'lib/client.js': 'var x = "--dsw-nope"' })
    expect(r2.status).toBe(1)
  })
  it('accepts a custom token list', () => {
    writeFileSync(join(dir, 'tokens.txt'), '--dsw-alias-custom\n')
    const r = run({ 'src/a.css': 'a { color: var(--dsw-alias-custom) }' }, ['--tokens', 'tokens.txt'])
    expect(r.status).toBe(0)
  })
})
