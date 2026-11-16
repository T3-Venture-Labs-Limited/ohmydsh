// @vitest-environment node
import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const src = resolve(import.meta.dirname, '../../src/client')
describe('boot path stays light', () => {
  it('the client entry loads the page with dynamic import() only and never pulls in the kit barrel', () => {
    const entry = readFileSync(resolve(src, 'index.tsx'), 'utf8')
    expect(entry).toMatch(/import\('\.\/views\.tsx'\)/)
    const staticImports = [...entry.matchAll(/^import [^\n]* from '([^']+)'/gm)].map((m) => m[1])
    expect(staticImports.filter((s) => s?.startsWith('.'))).toEqual(['./locale.ts', './locale.ts'])
    expect(entry).not.toMatch(/kit\/index\.ts/)
  })
  it('no settings page is left behind', () => {
    expect(readdirSync(src)).not.toContain('settings-page.tsx')
    expect(readFileSync(resolve(src, 'index.tsx'), 'utf8')).not.toMatch(/settings\.section/)
  })
  it('no source require()s the primitives package', () => {
    for (const file of readdirSync(src)) {
      const text = readFileSync(resolve(src, file), 'utf8')
      expect(text, file).not.toMatch(/require\(['"]@deepseek-ai\/dsh-client-ui-primitives/)
    }
  })
})
