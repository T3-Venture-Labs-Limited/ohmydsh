// DSH version gate for the registry instance patch. The patch relies on SkillRegistry's public list/snapshot/get, so it is
// only installed on the release line this plugin was built and tested against (package.json engines.dsh).
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export const SUPPORTED_MIN = '0.2.2-rc.1'
export const SUPPORTED_BELOW = '0.3.0-0'

interface Semver { major: number; minor: number; patch: number; pre: (string | number)[] }

export function parseSemver(text: string): Semver | undefined {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+.*)?$/.exec(text.trim())
  if (m === null) return undefined
  const pre = m[4] === undefined ? [] : m[4].split('.').map(part => (/^\d+$/.test(part) ? Number(part) : part))
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), pre }
}

/** Semver precedence: a release outranks its prereleases; prerelease identifiers compare left to right. */
export function compareSemver(a: Semver, b: Semver): number {
  for (const key of ['major', 'minor', 'patch'] as const) if (a[key] !== b[key]) return a[key] - b[key]
  if (a.pre.length === 0 || b.pre.length === 0) return a.pre.length === b.pre.length ? 0 : a.pre.length === 0 ? 1 : -1
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i += 1) {
    const x = a.pre[i]
    const y = b.pre[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    if (x === y) continue
    if (typeof x === 'number' && typeof y === 'number') return x - y
    if (typeof x === 'number') return -1
    if (typeof y === 'number') return 1
    return x < y ? -1 : 1
  }
  return 0
}

export function versionSupported(version: string): boolean {
  const v = parseSemver(version)
  const lo = parseSemver(SUPPORTED_MIN)
  const hi = parseSemver(SUPPORTED_BELOW)
  if (v === undefined || lo === undefined || hi === undefined) return false
  return compareSemver(v, lo) >= 0 && compareSemver(v, hi) < 0
}

/** The running DSH release: walk up from the CLI entry (process.argv[1]) to the `@deepseek-ai/dsh` manifest. */
export function detectDshVersion(entry: string | undefined = process.argv[1]): string | undefined {
  if (entry === undefined) return undefined
  let dir = dirname(entry)
  for (let i = 0; i < 6; i += 1) {
    const file = join(dir, 'package.json')
    if (existsSync(file)) {
      try {
        const pkg = JSON.parse(readFileSync(file, 'utf8')) as { name?: string; version?: string }
        if (pkg.name === '@deepseek-ai/dsh' && typeof pkg.version === 'string') return pkg.version
      } catch { /* keep walking */ }
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return undefined
}
