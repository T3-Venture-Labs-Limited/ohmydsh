import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { matches, nameTaken, relativeTime } from '../src/client/helpers.ts'
import type { SkillRow } from '../src/host/model.ts'

const row = (over: Partial<SkillRow>): SkillRow => ({
  id: 'x', name: 'alpha', description: 'Does alpha things', source: 'user-agents', symlink: false, editable: true, state: 'active', shadows: 0,
  errors: 0, warnings: 0, wouldLoad: true, modelInvocable: true, userInvocable: true, disabled: 'enabled', ...over,
})

describe('page helpers', () => {
  it('filters by query, state and source', () => {
    const a = row({}); const b = row({ name: 'beta', disabled: 'disabled-global' }); const c = row({ name: 'gamma', state: 'invalid', errors: 1, wouldLoad: false })
    expect(matches(a, 'ALPHA', 'all', 'all')).toBe(true)
    expect(matches(a, 'things', 'all', 'all')).toBe(true)
    expect(matches(a, 'nope', 'all', 'all')).toBe(false)
    expect(matches(b, '', 'disabled', 'all')).toBe(true)
    expect(matches(a, '', 'disabled', 'all')).toBe(false)
    expect(matches(b, '', 'enabled', 'all')).toBe(false)
    expect(matches(c, '', 'issues', 'all')).toBe(true)
    expect(matches(a, '', 'issues', 'all')).toBe(false)
    expect(matches(a, '', 'all', 'user-dsh')).toBe(false)
  })
  it('knows taken names but ignores invalid files', () => {
    expect(nameTaken([row({})], 'alpha')).toBe(true)
    expect(nameTaken([row({ state: 'invalid' })], 'alpha')).toBe(false)
  })
  it('formats relative time', () => {
    const now = Date.now()
    expect(relativeTime(now - 30_000, now)).toBe('just now')
    expect(relativeTime(now - 5 * 60_000, now)).toBe('5 min ago')
    expect(relativeTime(now - 3 * 3_600_000, now)).toBe('3 h ago')
  })
})

describe('boot path stays light', () => {
  const src = resolve(import.meta.dirname, '../src/client')
  it('the client entry loads the page with dynamic import() only', () => {
    const entry = readFileSync(resolve(src, 'index.tsx'), 'utf8')
    expect(entry).toMatch(/import\('\.\/views\.tsx'\)/)
    expect(entry).not.toMatch(/^import (?!type)[^'\n]* from '\.\/(views|Page|Detail|CreateModal|Row)\.tsx'/m)
    expect(entry).not.toMatch(/from '\.\.\/kit\/index\.ts'/)
    expect(entry).not.toMatch(/require\(['"]@deepseek-ai\/dsh-client-ui-primitives/)
  })
  it('does not poll', () => {
    for (const f of ['Page.tsx', 'Detail.tsx', 'index.tsx']) expect(readFileSync(resolve(src, f), 'utf8')).not.toMatch(/setInterval/)
  })
})
