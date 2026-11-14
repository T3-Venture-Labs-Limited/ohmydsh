// @vitest-environment node
// SS-2 regression: every file listed in package.json "files" exists, and LICENSE is MIT with a real holder.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = join(import.meta.dirname, '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { files: string[]; license: string; scripts: Record<string, string> }

describe('SS-2 packaging', () => {
  it('LICENSE exists, is MIT, and does not name "CI"', () => {
    const text = readFileSync(join(root, 'LICENSE'), 'utf8')
    expect(pkg.license).toBe('MIT')
    expect(text).toMatch(/^MIT License/)
    expect(text).toMatch(/Copyright \(c\) 2026 Superdao \(deestax\)/)
  })
  it('every entry of "files" that is a top-level file exists (lib is produced by the build)', () => {
    for (const f of pkg.files.filter((x) => x !== 'lib' && !x.includes('*'))) expect(existsSync(join(root, f)), f).toBe(true)
  })
  it('has a prepare script like the other repos', () => { expect(pkg.scripts.prepare).toBe('pnpm run build') })
})
