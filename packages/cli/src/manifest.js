// ohmydsh.json: parsing, validation and resolution into "what should be installed".
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, resolve as resolvePath } from 'node:path'
import { fileURLToPath } from 'node:url'
import { OmdError, isUrl } from './util.js'

export const DEFAULT_MANIFEST_URL = 'https://raw.githubusercontent.com/T3-Venture-Labs-Limited/ohmydsh/main/ohmydsh.json'
const EXACT = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/
const BUILD = /^(@[^@/]+\/)?[^@/]+@\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/

const isObj = (v) => typeof v === 'object' && v !== null && !Array.isArray(v)

/** Throws OmdError with every problem found; returns the (normalized) manifest. */
export function validateManifest(m) {
  const errs = []
  if (!isObj(m)) throw new OmdError('manifest: not a JSON object')
  if (typeof m.version !== 'string' || !EXACT.test(m.version)) errs.push('version must be an exact semver string')
  if (typeof m.dsh !== 'string' || !EXACT.test(m.dsh)) errs.push('dsh must be an exact version (the DSH release this set was tested with)')
  if (!isObj(m.plugins) || !isObj(m.plugins.core)) errs.push('plugins.core must be an object of name -> exact version')
  const packs = m.plugins?.packs ?? {}
  if (!isObj(packs)) errs.push('plugins.packs must be an object')
  const all = []
  for (const [name, v] of Object.entries(m.plugins?.core ?? {})) all.push(['plugins.core', name, v])
  if (isObj(packs)) for (const [pack, members] of Object.entries(packs)) {
    if (!isObj(members)) { errs.push(`plugins.packs.${pack} must be an object`); continue }
    for (const [name, v] of Object.entries(members)) all.push([`plugins.packs.${pack}`, name, v])
  }
  for (const [where, name, v] of all) if (typeof v !== 'string' || !EXACT.test(v)) errs.push(`${where}.${name}: "${String(v)}" is not an exact version (ranges are not allowed)`)
  const sources = m.sources ?? {}
  for (const [name, s] of Object.entries(sources)) {
    if (!isObj(s)) { errs.push(`sources.${name} must be an object`); continue }
    if (s.tarball !== undefined && (typeof s.tarball !== 'string' || /^http:\/\//i.test(s.tarball))) errs.push(`sources.${name}.tarball must be an https URL, a file: URL or a path next to the manifest`)
    if (s.workspace !== undefined && typeof s.workspace !== 'string') errs.push(`sources.${name}.workspace must be a path`)
    if (!all.some(([, n]) => n === name)) errs.push(`sources.${name} is not a plugin of this manifest`)
  }
  if (m.profile?.official !== undefined && !(Array.isArray(m.profile.official) && m.profile.official.every((s) => typeof s === 'string'))) errs.push('profile.official must be a list of bundle names')
  if (m.allowBuilds !== undefined && !(Array.isArray(m.allowBuilds) && m.allowBuilds.every((s) => typeof s === 'string' && BUILD.test(s)))) errs.push('allowBuilds must be a list of name@exact-version')
  if (errs.length > 0) throw new OmdError(`invalid manifest:\n  - ${errs.join('\n  - ')}`)
  return {
    ...m,
    node: m.node ?? '>=24',
    profile: { name: 'omd', defaults: undefined, official: [], ...(m.profile ?? {}) },
    plugins: { core: m.plugins.core, packs },
    packInfo: m.packInfo ?? {},
    sources,
    allowBuilds: m.allowBuilds ?? [],
  }
}

export function parseManifest(text) {
  let json
  try { json = JSON.parse(text) } catch (e) { throw new OmdError(`manifest: not valid JSON (${e.message})`) }
  return validateManifest(json)
}

/** Read a local path, file:// or http(s):// source as text. */
export async function readSource(src, fetchImpl = globalThis.fetch) {
  if (/^https?:\/\//i.test(src)) {
    const res = await fetchImpl(src, { signal: AbortSignal.timeout(30_000) })
    if (!res.ok) throw new OmdError(`could not fetch ${src}: HTTP ${res.status}`)
    return res.text()
  }
  const path = src.startsWith('file://') ? fileURLToPath(src) : src
  try { return await readFile(path, 'utf8') } catch (e) { throw new OmdError(`could not read ${src}: ${e.code ?? e.message}`) }
}

/** Resolve a path written inside the manifest against the manifest's own location (path or URL). */
export function resolveRelative(source, rel) {
  if (isUrl(source)) return new URL(rel, source).href
  return resolvePath(dirname(source), rel)
}

/** Pick the manifest to use: --manifest, $OMD_MANIFEST, the checkout the CLI runs from, else the published one. */
export function defaultManifestSource({ flag, env = process.env, cliDir }) {
  if (flag) return isUrl(flag) ? flag : resolvePath(flag)
  if (env.OMD_MANIFEST) return isUrl(env.OMD_MANIFEST) ? env.OMD_MANIFEST : resolvePath(env.OMD_MANIFEST)
  if (cliDir) {
    const local = resolvePath(cliDir, '../../../ohmydsh.json')
    if (existsSync(local)) return local
  }
  return DEFAULT_MANIFEST_URL
}

export async function loadManifest(source, fetchImpl) {
  const manifest = parseManifest(await readSource(source, fetchImpl))
  return { manifest, source, readRelative: (rel) => readSource(resolveRelative(source, rel), fetchImpl) }
}

export function packNames(manifest) {
  return Object.keys(manifest.plugins.packs)
}

/**
 * What should be installed for this manifest and set of enabled packs.
 * Every plugin installs from the npm registry at its exact pinned version. With --dev ours `link:` the workspace folder
 * instead; a source may also carry an explicit `tarball` (https URL, file: URL or a path next to a local manifest): the
 * escape hatch for a manifest that points at packed files, used by CI to test the registry shape before publishing.
 * @returns {{ plugins: Map<string, {version: string, spec: string, origin: string[]}> }}
 */
export function resolveDesired(manifest, { packs = [], dev = false, source }) {
  for (const p of packs) if (!manifest.plugins.packs[p]) throw new OmdError(`unknown pack "${p}" (packs: ${packNames(manifest).join(', ')})`)
  const plugins = new Map()
  const put = (name, version, origin) => {
    const existing = plugins.get(name)
    if (existing) { if (existing.version !== version) throw new OmdError(`${name} is pinned to two versions (${existing.version}, ${version})`); existing.origin.push(origin); return }
    plugins.set(name, { version, spec: specFor(manifest, name, version, { dev, source }), origin: [origin] })
  }
  for (const [name, v] of Object.entries(manifest.plugins.core)) put(name, v, 'core')
  for (const p of packs) for (const [name, v] of Object.entries(manifest.plugins.packs[p])) put(name, v, `pack:${p}`)
  return { plugins }
}

export function specFor(manifest, name, version, { dev, source }) {
  const s = manifest.sources[name]
  if (!s) return version
  if (dev && s.workspace !== undefined) {
    if (!source || isUrl(source)) throw new OmdError('--dev needs a local manifest (a checkout of the repo)')
    const dir = resolvePath(dirname(source), s.workspace)
    if (!existsSync(resolvePath(dir, 'package.json'))) throw new OmdError(`--dev: ${dir} has no package.json`)
    return `link:${dir}`
  }
  if (dev) throw new OmdError(`${name} has no workspace folder in the manifest, cannot --dev`)
  if (s.tarball === undefined) return version
  if (/^https:\/\//.test(s.tarball) || s.tarball.startsWith('file:')) return s.tarball
  // A path is resolved next to the manifest (a local --manifest used to test a set of packed tarballs).
  if (!source || isUrl(source)) throw new OmdError(`${name}: a relative tarball path needs a local manifest`)
  return `file:${resolvePath(dirname(source), s.tarball)}`
}

/** Plugins resolved from the registry at exact versions (those can be excluded from pnpm's minimum release age). */
export function registryPins(manifest, plugins) {
  return [...plugins].filter(([, p]) => p.spec === p.version).map(([name, p]) => `${name}@${p.version}`)
}

/**
 * Release-age exemptions for an install: the registry pins of the new set, plus the registry pins omd installed last time
 * (from the previous lock). pnpm re-checks every entry of the existing lockfile against minimumReleaseAge, so a version omd
 * itself installed a few hours ago would otherwise block the update (seen when two releases land within 24 h).
 */
export function releaseAgeExemptions(manifest, desired, previousLock) {
  const prev = Object.entries(previousLock?.plugins ?? {}).filter(([, p]) => p && p.spec === p.version).map(([name, p]) => `${name}@${p.version}`)
  return [...new Set([...registryPins(manifest, desired), ...prev])].sort()
}
