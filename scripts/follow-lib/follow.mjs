// The logic behind scripts/follow-upstream.mjs: which newer versions exist, pinning them, and the CHANGELOG text.
// Pure functions where possible so node:test can cover them without a network.
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { compare, gt, isAlpha, isPrerelease, nextPatch, parse } from './semver.mjs'

export const DSH = '@deepseek-ai/dsh'
export const npmUrl = (name, version) => `https://www.npmjs.com/package/${name}/v/${version}`

/** name -> { version, where } for every plugin the manifest pins that we do not build ourselves (not in `sources`). */
export function externalPlugins(manifest) {
  const own = new Set(Object.keys(manifest.sources ?? {}))
  const out = new Map()
  const put = (name, version, where) => { if (!own.has(name)) out.set(name, { version, where }) }
  for (const [n, v] of Object.entries(manifest.plugins.core ?? {})) put(n, v, 'core')
  for (const [pack, members] of Object.entries(manifest.plugins.packs ?? {})) for (const [n, v] of Object.entries(members)) put(n, v, `pack:${pack}`)
  return out
}

/**
 * The version to move `current` to, or null. Rules: the registry's `latest` dist-tag (never beta/next/preview tags),
 * never an alpha, never a downgrade, never from a stable version to a prerelease, and (optionally) only a release that
 * is at least `minAgeHours` old.
 * @param {{ 'dist-tags'?: Record<string,string>, versions?: Record<string,unknown>|string[], time?: Record<string,string> }} packument
 */
export function pickVersion(current, packument, { minAgeHours = 0, now = Date.now() } = {}) {
  const tags = packument['dist-tags'] ?? {}
  const versions = Array.isArray(packument.versions) ? packument.versions : Object.keys(packument.versions ?? {})
  let target = tags.latest
  if (!target) target = versions.filter((v) => parse(v) && !isPrerelease(v)).sort(compare).at(-1)
  if (!target || !parse(target) || isAlpha(target)) return null
  if (!gt(target, current)) return null
  if (isPrerelease(target) && !isPrerelease(current)) return null
  if (minAgeHours > 0) {
    const published = packument.time?.[target]
    if (!published || now - Date.parse(published) < minAgeHours * 3_600_000) return null
  }
  return target
}

/**
 * All candidates for a manifest.
 * @param {object} o
 * @param {(name: string) => Promise<object>} o.fetchPackument
 * @param {string[]} [o.hold]   package names that must not move (open `follow` + `hold` issue)
 * @param {string[]} [o.skip]   exact name@version that already failed (open `follow` issue): not retested
 * @param {string} [o.only]     name@version: consider only this one, ignoring hold/skip
 */
export async function findCandidates(manifest, { fetchPackument, hold = [], skip = [], only, minAgeHours = 0, now = Date.now() }) {
  const subjects = [[DSH, { version: manifest.dsh, where: 'dsh' }], ...externalPlugins(manifest)]
  const onlySpec = only ? splitSpec(only) : null
  const candidates = []
  const held = []
  const skipped = []
  const errors = []
  const results = await Promise.all(subjects.map(async ([name, cur]) => {
    if (onlySpec && onlySpec.name !== name) return null
    try { return [name, cur, await fetchPackument(name)] } catch (e) { errors.push(`${name}: ${e.message}`); return null }
  }))
  for (const r of results) {
    if (!r) continue
    const [name, cur, packument] = r
    let to
    if (onlySpec) {
      const versions = Array.isArray(packument.versions) ? packument.versions : Object.keys(packument.versions ?? {})
      if (!versions.includes(onlySpec.version)) { errors.push(`${onlySpec.raw}: that version is not on npm`); continue }
      to = gt(onlySpec.version, cur.version) ? onlySpec.version : null
      if (!to) { errors.push(`${onlySpec.raw}: not newer than the pinned ${cur.version}`); continue }
    } else {
      to = pickVersion(cur.version, packument, { minAgeHours, now })
      if (!to) continue
      if (hold.includes(name)) { held.push({ name, from: cur.version, to }); continue }
      if (skip.includes(`${name}@${to}`)) { skipped.push({ name, from: cur.version, to }); continue }
    }
    candidates.push({ name, kind: name === DSH ? 'dsh' : 'plugin', where: cur.where, from: cur.version, to })
  }
  const order = (c) => (c.kind === 'dsh' ? 0 : 1)
  candidates.sort((a, b) => order(a) - order(b) || a.name.localeCompare(b.name))
  return { candidates, held, skipped, errors }
}

export function splitSpec(spec) {
  const i = spec.lastIndexOf('@')
  if (i <= 0) throw new Error(`expected name@version, got "${spec}"`)
  const name = spec.slice(0, i)
  const version = spec.slice(i + 1)
  if (!parse(version)) throw new Error(`"${spec}": "${version}" is not an exact version`)
  return { name, version, raw: spec }
}

const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'))
const writeJson = (file, v) => writeFileSync(file, `${JSON.stringify(v, null, 2)}\n`)
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')
const shield = (v) => v.replace(/-/g, '--')

/** Rewrite `file` with `fn(text)`; returns true when it changed. */
function rewrite(file, fn) {
  if (!existsSync(file)) return false
  const before = readFileSync(file, 'utf8')
  const after = fn(before)
  if (after === before) return false
  writeFileSync(file, after)
  return true
}

/** Every place the DSH version is written down besides ohmydsh.json (see docs/DESIGN.md, "Release and maintenance"). */
export function applyDshPin(root, from, to) {
  const changed = []
  const mark = (file, did) => { if (did) changed.push(file) }
  const exactDeps = new RegExp(`("@deepseek-ai/dsh[a-z0-9-]*"\\s*:\\s*")${escapeRe(from)}(")`, 'g')
  const pkgDirs = existsSync(join(root, 'packages')) ? readdirSync(join(root, 'packages')) : []
  for (const dir of pkgDirs) {
    for (const rel of [join('packages', dir, 'package.json'), join('packages', dir, 'template', 'package.json')]) {
      mark(rel, rewrite(join(root, rel), (t) => t.replace(exactDeps, `$1${to}$2`)))
    }
  }
  // Our dev workspace's pnpm: the rc builds are newer than the minimum release age.
  mark('pnpm-workspace.yaml', rewrite(join(root, 'pnpm-workspace.yaml'), (t) => t.replace(new RegExp(`('@deepseek-ai/dsh[a-z0-9-]*@)${escapeRe(from)}(')`, 'g'), `$1${to}$2`)))
  mark('README.md', rewrite(join(root, 'README.md'), (t) => t.replaceAll(`dsh-${shield(from)}-`, `dsh-${shield(to)}-`).replaceAll(`DeepSeek Harness ${from}`, `DeepSeek Harness ${to}`)))
  for (const rel of ['docs/DESIGN.md', 'apps/desktop/tests/smoke/ohmydsh.json']) {
    mark(rel, rewrite(join(root, rel), (t) => t.replace(new RegExp(`("dsh"\\s*:\\s*")${escapeRe(from)}(")`), `$1${to}$2`)))
  }
  return changed
}

/**
 * Pin `specs` (name@version) in the manifest file under `root`. Returns what changed.
 * @returns {{ bumps: Array<{name: string, kind: string, from: string, to: string}>, files: string[] }}
 */
export function applyPins(root, specs) {
  const file = join(root, 'ohmydsh.json')
  const manifest = readJson(file)
  const bumps = []
  const files = new Set(['ohmydsh.json'])
  for (const spec of specs) {
    const { name, version } = splitSpec(spec)
    if (name === DSH) {
      if (manifest.dsh === version) continue
      for (const f of applyDshPin(root, manifest.dsh, version)) files.add(f)
      bumps.push({ name, kind: 'dsh', from: manifest.dsh, to: version })
      manifest.dsh = version
      continue
    }
    const holders = [manifest.plugins.core, ...Object.values(manifest.plugins.packs ?? {})].filter((m) => name in m)
    if (holders.length === 0) throw new Error(`${name} is not a plugin of ohmydsh.json`)
    if (name in (manifest.sources ?? {})) throw new Error(`${name} is built from this repo; bump its package.json and pin together instead`)
    for (const h of holders) {
      if (h[name] === version) continue
      bumps.push({ name, kind: 'plugin', from: h[name], to: version })
      h[name] = version
    }
  }
  writeJson(file, manifest)
  return { bumps, files: [...files] }
}

/** The CHANGELOG bullet for one bump. */
export function bumpLine(b) {
  const label = b.kind === 'dsh' ? 'DeepSeek Harness' : b.name
  return `- ${label} ${b.from} -> ${b.to} ([npm](${npmUrl(b.name, b.to)}))`
}

/**
 * Add the CHANGELOG section for the next patch version. An `## Unreleased` section (other work waiting for a release)
 * becomes that version's section; the bumps are appended to it. Returns the new text.
 */
export function changelogWith(text, version, bumps) {
  const lines = bumps.map(bumpLine)
  const dsh = bumps.find((b) => b.kind === 'dsh')
  const intro = 'Automatic follow-up release. Everything below passed the full install, boot and upgrade test before it was released.'
  const bumpBlock = [`### Followed upstream`, '', ...lines].join('\n')
  const rows = text.split('\n')
  const head = rows.findIndex((l) => /^##\s+\[?Unreleased\]?\s*$/i.test(l))
  if (head !== -1) {
    let end = rows.findIndex((l, i) => i > head && /^##\s/.test(l))
    if (end === -1) end = rows.length
    const body = rows.slice(head + 1, end).join('\n').trim()
    const section = [`## ${version}`, '', ...(body ? [body, ''] : []), bumpBlock, ''].join('\n')
    return [...rows.slice(0, head), section, ...rows.slice(end)].join('\n')
  }
  const first = rows.findIndex((l) => /^##\s/.test(l))
  const section = [`## ${version}`, '', intro, '', ...lines, ...(dsh ? ['', `Tested with DeepSeek Harness ${dsh.to}.`] : []), ''].join('\n')
  if (first === -1) return `${text.replace(/\s*$/, '\n\n')}${section}`
  return [...rows.slice(0, first), section, ...rows.slice(first)].join('\n')
}

/** Bump ohmydsh.json, the CLI and the desktop app to `version`, and write the CHANGELOG section. */
export function applyReleaseNotes(root, bumps, version) {
  const files = []
  for (const rel of ['ohmydsh.json', 'packages/cli/package.json', 'apps/desktop/package.json']) {
    const file = join(root, rel)
    if (!existsSync(file)) continue
    const j = readJson(file)
    if (j.version === version) continue
    j.version = version
    writeJson(file, j)
    files.push(rel)
  }
  const changelog = join(root, 'CHANGELOG.md')
  writeFileSync(changelog, changelogWith(readFileSync(changelog, 'utf8'), version, bumps))
  files.push('CHANGELOG.md')
  return files
}

export const releaseVersion = (root) => nextPatch(readJson(join(root, 'ohmydsh.json')).version)
export { nextPatch }

/** Title of the issue for a candidate that fails, and the reverse. */
export const issueTitle = (name, version) => `follow: ${name} ${version} does not pass`
export function parseIssueTitle(title) {
  const m = /^follow:\s+(\S+)\s+(\S+)\s+does not pass\s*$/.exec(title ?? '')
  return m ? { name: m[1], version: m[2] } : null
}
/** The package a `follow` issue is about, whatever its title says after the name (used for holds). */
export function issuePackage(title) {
  const m = /^follow:\s+(\S+)/.exec(title ?? '')
  return m ? m[1] : null
}
