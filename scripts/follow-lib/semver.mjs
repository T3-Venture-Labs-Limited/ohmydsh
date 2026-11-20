// Minimal semver (no dependencies): parse, compare with prerelease ordering, and the tiny range syntax our packages use.
const RE = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/

export function parse(v) {
  const m = RE.exec(String(v).trim())
  if (!m) return null
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), pre: m[4] === undefined ? [] : m[4].split('.') }
}

const isNum = (s) => /^\d+$/.test(s)

function comparePre(a, b) {
  // A version without a prerelease is greater than the same version with one.
  if (a.length === 0 && b.length === 0) return 0
  if (a.length === 0) return 1
  if (b.length === 0) return -1
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] === undefined) return -1
    if (b[i] === undefined) return 1
    if (a[i] === b[i]) continue
    const an = isNum(a[i])
    const bn = isNum(b[i])
    if (an && bn) return Number(a[i]) < Number(b[i]) ? -1 : 1
    if (an) return -1
    if (bn) return 1
    return a[i] < b[i] ? -1 : 1
  }
  return 0
}

/** -1, 0 or 1. Throws on anything that is not a semver string. */
export function compare(a, b) {
  const x = parse(a)
  const y = parse(b)
  if (!x) throw new Error(`not a semver version: ${a}`)
  if (!y) throw new Error(`not a semver version: ${b}`)
  for (const k of ['major', 'minor', 'patch']) if (x[k] !== y[k]) return x[k] < y[k] ? -1 : 1
  return comparePre(x.pre, y.pre)
}

export const gt = (a, b) => compare(a, b) > 0
export const isPrerelease = (v) => (parse(v)?.pre.length ?? 0) > 0
/** True for an `-alpha` / `-alpha.N` version (those are never followed). */
export const isAlpha = (v) => /^alpha(\.|$)/.test(parse(v)?.pre[0] ?? '') || /(^|[.-])alpha([.-]|$)/.test(parse(v)?.pre.join('.') ?? '')

export function nextPatch(v) {
  const p = parse(v)
  if (!p) throw new Error(`not a semver version: ${v}`)
  return `${p.major}.${p.minor}.${p.patch + 1}`
}

/**
 * Does `version` satisfy a space-separated list of comparators (`>=0.2.2-rc.1 <0.3.0-0`, `^1.2.3` is not supported)?
 * Prerelease tags are compared as plain versions (no "prereleases only match their own tuple" rule).
 */
export function satisfies(version, range) {
  for (const part of String(range).trim().split(/\s+/).filter(Boolean)) {
    const m = /^(>=|<=|>|<|=)?(.+)$/.exec(part)
    const op = m[1] ?? '='
    if (!parse(m[2])) throw new Error(`unsupported range: ${range}`)
    const c = compare(version, m[2])
    const ok = op === '>=' ? c >= 0 : op === '<=' ? c <= 0 : op === '>' ? c > 0 : op === '<' ? c < 0 : c === 0
    if (!ok) return false
  }
  return true
}
