import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// tldraw is under a licence that forbids production use without a paid key, so it must never come back:
// not as a source import, not as a dependency, and not inside the shipped bundles.
const root = join(fileURLToPath(new URL('.', import.meta.url)), '..')

function files(dir: string, pattern: RegExp): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...files(full, pattern))
    else if (pattern.test(entry)) out.push(full)
  }
  return out
}

describe('no tldraw', () => {
  it('no file under src/ imports tldraw or @tldraw/*', () => {
    const sources = files(join(root, 'src'), /\.(ts|tsx|js|mjs|css)$/)
    expect(sources.length).toBeGreaterThan(20)
    const importers = sources.filter(file => /(?:from|import|require\()\s*\(?\s*['"](?:tldraw|@tldraw\/)/.test(readFileSync(file, 'utf8')))
    expect(importers).toEqual([])
  })

  it('package.json declares no tldraw dependency', () => {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as Record<string, Record<string, string> | undefined>
    for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
      expect(Object.keys(pkg[field] ?? {}).filter(name => name === 'tldraw' || name.startsWith('@tldraw/')), field).toEqual([])
    }
  })

  // Runs against the last build (`pnpm run build`); skipped when lib/ does not exist yet.
  const lib = join(root, 'lib')
  describe.skipIf(!existsSync(join(lib, 'client.js')))('built lib/', () => {
    it('contains neither "tldraw" nor "cdn.tldraw.com"', () => {
      const built = files(lib, /\.js$/)
      expect(built.length).toBeGreaterThan(2)
      const offenders = built.filter(file => /tldraw/i.test(readFileSync(file, 'utf8')))
      expect(offenders).toEqual([])
    })
  })
})
