// @vitest-environment node
import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const src = resolve(import.meta.dirname, '../src/client')
describe('boot path stays light', () => {
  it('the client entry loads pages with dynamic import() only', () => {
    const entry = readFileSync(resolve(src, 'index.tsx'), 'utf8')
    expect(entry).toMatch(/import\('\.\/views\.tsx'\)/)
    expect(entry).not.toMatch(/^import [^'\n]* from '\.\/(views|settings-page|panel)\.tsx'/m)
    expect(entry).not.toMatch(/from '\.\.\/kit\/index\.ts'/)
  })
  it('no source reads literal colours or require()s the primitives package', () => {
    for (const file of readdirSync(src)) {
      const text = readFileSync(resolve(src, file), 'utf8')
      expect(text, file).not.toMatch(/require\(['"]@deepseek-ai\/dsh-client-ui-primitives/)
    }
  })
})
