// The omd profile on disk: staging copy -> install -> health check -> swap, with omd-prev kept for rollback.
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { composeCheck, describeCompose, isProfileRunning } from './health.js'
import { diffLock, makeLock, readLock, writeLock } from './lock.js'
import { readBlock, rewriteBlock, rewriteWorkspaceYaml } from './managed.js'
import { resolveDesired, releaseAgeExemptions } from './manifest.js'
import { mergeHosts, tailnetHosts, trustedHostsRow } from './tailnet.js'
import { OmdError } from './util.js'

export const BASE_BUNDLES = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']

export const profilesDir = (home) => join(home, 'profiles')
export const profileDir = (home, name) => join(profilesDir(home), name)
export const stagingName = (name) => `${name}-next`
export const prevName = (name) => `${name}-prev`

const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'))
const writeJson = (file, v) => writeFileSync(file, `${JSON.stringify(v, null, 2)}\n`)

/** The package.json for the new profile: keeps everything the user has, replaces only what omd manages. */
export function buildPackageJson(existing, { desired, lock, official, profile }) {
  const pkg = existing ? structuredClone(existing) : { name: `dsh-profile-${profile}`, private: true, dependencies: {}, dsh: { profile: { bundles: [...BASE_BUNDLES] } } }
  pkg.dependencies ??= {}
  pkg.dsh ??= {}
  pkg.dsh.profile ??= {}
  const bundles = [...(pkg.dsh.profile.bundles ?? BASE_BUNDLES)]
  const removed = Object.keys(lock?.plugins ?? {}).filter((n) => !desired.has(n))
  for (const name of removed) {
    delete pkg.dependencies[name]
    const i = bundles.indexOf(name)
    if (i >= 0) bundles.splice(i, 1)
  }
  // Official optional bundles we turned on last time but no longer want are switched off again.
  for (const name of lock?.official ?? []) if (!official.includes(name)) { const i = bundles.indexOf(name); if (i >= 0) bundles.splice(i, 1) }
  for (const name of official) if (!bundles.includes(name)) bundles.push(name)
  // Bundle order is patch order: a plugin whose rows override another's (browser-takeover overrides the `browser` row)
  // must load after it. A bundle that is new to the profile goes in manifest order, just before the next one of ours
  // that is already there; appending it at the end would put a renamed or added plugin after the plugins that patch it.
  const names = [...desired.keys()]
  names.forEach((name, i) => {
    pkg.dependencies[name] = desired.get(name).spec
    if (bundles.includes(name)) return
    const next = names.slice(i + 1).find((n) => bundles.includes(n))
    if (next === undefined) bundles.push(name)
    else bundles.splice(bundles.indexOf(next), 0, name)
  })
  pkg.dependencies = Object.fromEntries(Object.entries(pkg.dependencies).sort(([a], [b]) => a.localeCompare(b)))
  pkg.dsh.profile.bundles = bundles
  pkg.dsh.profile.patchReload ??= 'live'
  return pkg
}

/** YAML for the managed block of cordis.patch.yml: default rows plus the rows of every enabled pack. */
export async function managedPatchYaml(loaded, packs, trustedHosts = []) {
  const parts = []
  const { manifest, readRelative } = loaded
  if (manifest.profile.defaults) parts.push((await readRelative(manifest.profile.defaults)).trimEnd())
  for (const p of packs) {
    const rows = manifest.packInfo[p]?.rows
    if (rows) parts.push((await readRelative(rows)).trimEnd())
  }
  const hostsRow = trustedHostsRow(trustedHosts)
  if (hostsRow) parts.push(hostsRow)
  return parts.filter(Boolean).join('\n\n')
}

/** Copy everything but node_modules, so the staging profile keeps the user's rows and settings. */
function copyProfile(from, to) {
  cpSync(from, to, { recursive: true, filter: (src) => !/(^|\/)node_modules(\/|$)/.test(src.slice(from.length)) })
}

function read(file, fallback) {
  return existsSync(file) ? readFileSync(file, 'utf8') : fallback
}

const PATCH_DEFAULT = '# Your patch layer for this dsh profile, applied after every bundle layer.\n[]\n'
const WORKSPACE_DEFAULT = 'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n'

/**
 * Plan and (unless dryRun) carry out a profile change.
 * @param {object} ctx  { home, env, run, log, isRunning? }
 * @param {object} opts { loaded, name, packs, dev, dryRun, force, bootCheck }
 */
export async function syncProfile(ctx, opts) {
  const { loaded, name } = opts
  const { manifest } = loaded
  const liveDir = profileDir(ctx.home, name)
  const stageDir = profileDir(ctx.home, stagingName(name))
  const prevDir = profileDir(ctx.home, prevName(name))
  const lock = existsSync(liveDir) ? readLock(liveDir) : null
  const packs = [...new Set(opts.packs)].sort()
  const { plugins: desired } = resolveDesired(manifest, { packs, dev: opts.dev, source: loaded.source })
  const diff = diffLock(lock, desired)
  const official = manifest.profile.official
  // Hosts saved earlier stay, so a run while Tailscale is down never drops them. A dry run starts no processes.
  const trustedHosts = mergeHosts(lock?.trustedHosts, opts.dryRun ? [] : tailnetHosts(ctx), opts.trustedHosts)
  const managedYaml = await managedPatchYaml(loaded, packs, trustedHosts)
  const plan = { diff, packs, desired, official, managedYaml, trustedHosts, live: existsSync(liveDir), lock }
  if (opts.dryRun) return { ...plan, applied: false }

  const log = ctx.log
  mkdirSync(profilesDir(ctx.home), { recursive: true })
  rmSync(stageDir, { recursive: true, force: true })
  try {
    log.step(`staging ${stagingName(name)}`)
    if (existsSync(liveDir)) copyProfile(liveDir, stageDir)
    else mkdirSync(stageDir, { recursive: true })
    const existingPkg = existsSync(join(stageDir, 'package.json')) ? readJson(join(stageDir, 'package.json')) : null
    writeJson(join(stageDir, 'package.json'), buildPackageJson(existingPkg, { desired, lock, official, profile: name }))
    const patchFile = join(stageDir, 'cordis.patch.yml')
    writeFileSync(patchFile, rewriteBlock(read(patchFile, PATCH_DEFAULT), managedYaml, 'list'))
    if (!existsSync(join(stageDir, 'cordis.yml'))) writeFileSync(join(stageDir, 'cordis.yml'), '# dsh profile root. Edit cordis.patch.yml, not this file.\n[]\n')
    const wsFile = join(stageDir, 'pnpm-workspace.yaml')
    const ws = rewriteWorkspaceYaml(read(wsFile, WORKSPACE_DEFAULT), { allowBuilds: manifest.allowBuilds, releaseAgeExclude: releaseAgeExemptions(manifest, desired, lock) })
    writeFileSync(wsFile, ws.text)
    for (const w of ws.warnings) log.warn(w)

    log.step('installing plugins (pnpm, may take a minute)')
    // The staging profile's package.json is rewritten above, so its lockfile is expected to change; pnpm defaults to
    // --frozen-lockfile under CI=true, which would refuse exactly this.
    const inst = ctx.run('dsh', ['plugin', '--profile', stagingName(name), 'install', '--no-frozen-lockfile'], { env: ctx.env })
    if (inst.error || inst.status !== 0) throw new OmdError(`plugin install failed:\n${(inst.error?.message ?? `${inst.stdout}\n${inst.stderr}`).trim().split('\n').slice(-25).join('\n')}`)

    log.step('checking that DSH starts with the new set')
    const check = composeCheck(ctx, { profile: stagingName(name), plugins: [...desired.keys()], managedYaml })
    if (!check.ok) throw new OmdError(`the new profile does not compose cleanly:\n  - ${describeCompose(check).join('\n  - ')}`)
    log.ok('composed config is clean, every row applied')
    if (opts.bootCheck) {
      const boot = await ctx.bootCheck(stagingName(name), ctx)
      if (!boot.ok) throw new OmdError(`web boot check failed:\n  - ${boot.problems.join('\n  - ')}`)
      log.ok(`web boot check passed (${boot.url})`)
    }

    const newLock = makeLock({ manifest, source: loaded.source, dev: opts.dev, packs, plugins: desired, official, trustedHosts, dsh: opts.dsh })
    writeLock(stageDir, newLock)
    const running = (ctx.isRunning ?? isProfileRunning)(liveDir)
    if (existsSync(liveDir) && running === true && !opts.force) {
      throw new OmdError(`DSH is running on profile "${name}". Swapping its folder under it would break plugin code it loads lazily.\n  Stop it and re-run, or pass --force to swap anyway. Nothing was changed.`)
    }
    const hadLive = existsSync(liveDir)
    swapIn(ctx, name, { hadLive })
    const undoSwap = () => {
      if (hadLive && existsSync(prevDir)) rollbackSwap(ctx, name)
      else rmSync(liveDir, { recursive: true, force: true })
    }
    log.step('verifying the swapped profile')
    const after = composeCheck(ctx, { profile: name, plugins: [...desired.keys()], managedYaml })
    if (!after.ok) {
      log.error(`the swapped profile failed its check, rolling back:\n  - ${describeCompose(after).join('\n  - ')}`)
      undoSwap()
      throw new OmdError('update rolled back; the previous profile is active again')
    }
    // The profile was built and checked with the DSH it is meant for (a staged copy when DSH changes). Only now is
    // the global DSH switched; if that fails the profile goes back too, so the two always match.
    if (opts.switchDsh) {
      try { opts.switchDsh() } catch (e) {
        undoSwap()
        throw new OmdError(`${e.message}\n  The previous profile is active again; nothing else was changed.`)
      }
    }
    return { ...plan, applied: true, lock: newLock, running: running === true }
  } catch (e) {
    if (ctx.env.OMD_KEEP_STAGING) ctx.log.warn(`OMD_KEEP_STAGING is set: leaving ${stageDir} for inspection`)
    else rmSync(stageDir, { recursive: true, force: true })
    throw e
  }
}

/** staging -> live, live -> prev. If the second rename fails the first is undone. */
export function swapIn(ctx, name, { hadLive }) {
  const live = profileDir(ctx.home, name)
  const stage = profileDir(ctx.home, stagingName(name))
  const prev = profileDir(ctx.home, prevName(name))
  if (hadLive) {
    rmSync(prev, { recursive: true, force: true })
    renameSync(live, prev)
  }
  try {
    renameSync(stage, live)
  } catch (e) {
    if (hadLive) renameSync(prev, live)
    throw e
  }
}

/** Exchange live and prev. Reversible: running it twice puts everything back. */
export function rollbackSwap(ctx, name) {
  const live = profileDir(ctx.home, name)
  const prev = profileDir(ctx.home, prevName(name))
  const tmp = profileDir(ctx.home, `${name}-swap`)
  if (!existsSync(prev)) throw new OmdError(`there is no previous profile (${prevName(name)}) to roll back to`)
  rmSync(tmp, { recursive: true, force: true })
  if (existsSync(live)) renameSync(live, tmp)
  try {
    renameSync(prev, live)
  } catch (e) {
    if (existsSync(tmp)) renameSync(tmp, live)
    throw e
  }
  if (existsSync(tmp)) renameSync(tmp, prev)
}

export function describeLock(lock) {
  if (!lock) return 'no ohmydsh lock file (this profile was not installed by omd)'
  return `ohmydsh ${lock.manifest.version} (dsh ${lock.manifest.dsh}), ${Object.keys(lock.plugins).length} plugins${lock.packs.length ? `, packs: ${lock.packs.join(', ')}` : ''}${lock.dev ? ', dev links' : ''}`
}

export { readBlock }
