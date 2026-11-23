// The omd commands. Every command takes a ctx so tests can inject the process runner and paths.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { composeCheck, describeCompose, dshVersion, installedVersion, isProfileRunning } from './health.js'
import { dshSpec, planDsh, stageDsh, switchDsh, warnSkipped } from './dsh.js'
import { classifyDeps, diffLock, lockedDsh, readLock } from './lock.js'
import { defaultManifestSource, loadManifest, packNames, patchFileName, resolveDesired } from './manifest.js'
import { describeLock, patchApplied, PATCH_DIR, prevName, profileDir, rollbackSwap, syncProfile } from './profile.js'
import { mergeHosts, tailnetHosts } from './tailnet.js'
import { OmdError, c, which } from './util.js'

const profileNameOf = (ctx, manifest) => ctx.flags.profile ?? ctx.env.OMD_PROFILE ?? manifest?.profile?.name ?? 'omd'

async function load(ctx, { preferLock = false } = {}) {
  let source = defaultManifestSource({ flag: ctx.flags.manifest, env: ctx.env, cliDir: ctx.cliDir })
  if (preferLock && !ctx.flags.manifest && !ctx.env.OMD_MANIFEST) {
    const lock = readLock(profileDir(ctx.home, ctx.flags.profile ?? ctx.env.OMD_PROFILE ?? 'omd'))
    const s = lock?.manifest?.source
    if (s && (/^https?:/.test(s) || existsSync(s))) source = s
  }
  const loaded = await loadManifest(source, ctx.fetch)
  return { loaded, name: profileNameOf(ctx, loaded.manifest) }
}

function splitList(v) {
  return typeof v === 'string' ? v.split(',').map((s) => s.trim()).filter(Boolean) : []
}

function printDiff(ctx, diff) {
  const { log } = ctx
  for (const a of diff.add) log.info(`${c.green('+')} ${a.name} ${a.to.version}`)
  for (const x of diff.change) log.info(`${c.yellow('~')} ${x.name} ${x.from.version} -> ${x.to.version}`)
  for (const r of diff.remove) log.info(`${c.red('-')} ${r.name} ${r.from.version}`)
  if (diff.empty) log.info('no plugin changes')
}

function finish(ctx, name, res) {
  const { log } = ctx
  log.ok(`profile "${name}" is now ${describeLock(res.lock)}`)
  if (res.running) log.warn(`DSH is running on "${name}": restart it to load the new set (omd never restarts it for you).`)
  else log.info(`start it with: omd`)
}

/**
 * Run `fn(ctx, extra)` with the DSH this manifest wants.
 *  - same version, `--no-dsh-install`, or a DSH omd did not install (the desktop app's own runtime): DSH is left alone;
 *  - no DSH at all: it is installed first (there is nothing that could break);
 *  - a different version: it is installed into a temporary prefix, `fn` builds and checks the profile with THAT binary
 *    and only after the swap passed does `extra.switchDsh()` replace the global DSH. A failure anywhere leaves both the
 *    profile and DSH as they were.
 * @param {{ repair: boolean }} how  repair: also fix a DSH that drifted from the pin (setup); false: move DSH only when
 *   the pin changed (update), so a DSH the user picked is never replaced behind their back.
 */
export async function withDsh(ctx, manifest, { repair, dryRun = false }, fn) {
  const plan = planDsh(ctx, manifest.dsh)
  const have = plan.have
  const pinMoved = repair || (ctx.lockDsh ?? null) !== manifest.dsh
  if (plan.action === 'none' || (!pinMoved && plan.action !== 'skip')) return fn(ctx, { dsh: { version: have, previous: null } })
  if (plan.action === 'skip') {
    if (pinMoved) warnSkipped(ctx, plan)
    return fn(ctx, { dsh: { version: have, previous: null } })
  }
  if (dryRun) {
    ctx.log.info(`DSH ${have ?? '(none)'} -> ${plan.want} would be installed first (tried in a temporary folder, switched only if the new set passes its checks)`)
    return fn(ctx, { dsh: { version: have, previous: null } })
  }
  if (have === null) {
    switchDsh(ctx, plan.install, plan.want, null)
    return fn(ctx, { dsh: { version: plan.want, previous: null } })
  }
  ctx.log.step(`DeepSeek Harness ${have} -> ${plan.want}: trying ${dshSpec(plan.want)} in a temporary folder first`)
  const staged = stageDsh(ctx, plan.want)
  try {
    return await fn({ ...ctx, env: staged.env }, { dsh: { version: plan.want, previous: have }, switchDsh: () => switchDsh(ctx, plan.install, plan.want, have) })
  } finally { staged.cleanup() }
}

export async function setup(ctx) {
  const { loaded, name } = await load(ctx, { preferLock: true })
  const { manifest } = loaded
  if (Number(process.versions.node.split('.')[0]) < 24) throw new OmdError(`Node ${process.versions.node} is too old; ohmydsh needs Node 24 or newer.`)
  ctx.log.step(`ohmydsh ${manifest.version} for DSH ${manifest.dsh}${ctx.flags.dev ? ' (dev links)' : ''}`)
  const lock = readLock(profileDir(ctx.home, name))
  const packs = [...new Set([...(lock?.packs ?? []), ...splitList(ctx.flags.pack)])]
  const res = await withDsh(ctx, manifest, { repair: true }, (on, extra) => syncProfile(on, { loaded, name, packs, dev: Boolean(ctx.flags.dev) || Boolean(lock?.dev && !ctx.flags.manifest), force: Boolean(ctx.flags.force), bootCheck: Boolean(ctx.flags['boot-check']), trustedHosts: splitList(ctx.flags['trusted-host']), ...extra }))
  if (res.trustedHosts?.length > 0) ctx.log.ok(`trusted hosts saved in the profile: ${res.trustedHosts.join(', ')}`)
  printDiff(ctx, res.diff)
  finish(ctx, name, res)
  await doctor(ctx, { quietHeader: true })
}

export async function add(ctx, packArgs) {
  if (packArgs.length === 0) throw new OmdError('usage: omd add <pack>...')
  return changePacks(ctx, (current) => [...new Set([...current, ...packArgs])])
}

export async function remove(ctx, packArgs) {
  if (packArgs.length === 0) throw new OmdError('usage: omd remove <pack>...')
  return changePacks(ctx, (current) => current.filter((p) => !packArgs.includes(p)), packArgs)
}

async function changePacks(ctx, f, mustExist = []) {
  const { loaded, name } = await load(ctx, { preferLock: true })
  const live = profileDir(ctx.home, name)
  const lock = readLock(live)
  if (!lock) throw new OmdError(`profile "${name}" was not set up by omd; run \`omd setup\` first.`)
  for (const p of mustExist) if (!packNames(loaded.manifest).includes(p)) throw new OmdError(`unknown pack "${p}" (packs: ${packNames(loaded.manifest).join(', ')})`)
  const packs = f(lock.packs)
  const res = await syncProfile(ctx, { loaded, name, packs, dev: lock.dev, force: Boolean(ctx.flags.force), bootCheck: Boolean(ctx.flags['boot-check']), dsh: { version: lockedDsh(lock), previous: lock.dsh?.previous ?? null } })
  printDiff(ctx, res.diff)
  finish(ctx, name, res)
  for (const p of packs) {
    const req = loaded.manifest.packInfo[p]?.requires ?? []
    if (!lock.packs.includes(p) && req.length > 0) ctx.log.info(`${p} needs: ${req.join('; ')}`)
  }
}

export async function update(ctx) {
  const { loaded, name } = await load(ctx)
  const live = profileDir(ctx.home, name)
  const lock = readLock(live)
  if (!lock) throw new OmdError(`profile "${name}" was not set up by omd; run \`omd setup\` first.`)
  const { manifest } = loaded
  ctx.log.step(`ohmydsh ${lock.manifest.version} -> ${manifest.version}`)
  const dev = ctx.flags.dev !== undefined ? Boolean(ctx.flags.dev) : lock.dev
  const dryRun = Boolean(ctx.flags['dry-run'])
  // The pin this profile was set up for; DSH is only moved when the new manifest pins another one.
  const res = await withDsh({ ...ctx, lockDsh: lock.manifest.dsh }, manifest, { repair: false, dryRun }, (on, extra) => syncProfile(on, { loaded, name, packs: lock.packs, dev, dryRun, force: Boolean(ctx.flags.force), bootCheck: Boolean(ctx.flags['boot-check']), trustedHosts: splitList(ctx.flags['trusted-host']), ...extra }))
  printDiff(ctx, res.diff)
  if (!res.applied) { ctx.log.info('dry run: nothing changed'); return }
  finish(ctx, name, res)
  ctx.log.info(`the previous set is kept as ${prevName(name)}; \`omd rollback\` returns to it`)
}

export async function rollback(ctx) {
  const name = ctx.flags.profile ?? ctx.env.OMD_PROFILE ?? 'omd'
  const live = profileDir(ctx.home, name)
  const before = readLock(live)
  const running = isProfileRunning(live)
  if (running === true && !ctx.flags.force) throw new OmdError(`DSH is running on profile "${name}"; stop it first or pass --force.`)
  rollbackSwap(ctx, name)
  const after = readLock(live)
  // The profile we returned to was built for its own DSH (kept in its lock). Put DSH back to match; if that fails the
  // swap is undone, so profile and DSH never disagree.
  const wantDsh = lockedDsh(after)
  const have = dshVersion(ctx)
  if (after && wantDsh && have !== wantDsh) {
    const plan = planDsh(ctx, wantDsh)
    if (plan.action === 'install') {
      try { switchDsh(ctx, plan.install, wantDsh, have) } catch (e) {
        rollbackSwap(ctx, name)
        throw new OmdError(`${e.message}\n  The rollback was undone: the profile is back at ${describeLock(before)}.`)
      }
      ctx.log.ok(`DSH ${have ?? '(none)'} -> ${wantDsh}`)
    } else if (plan.action === 'skip') warnSkipped(ctx, plan)
  }
  ctx.log.ok(`rolled back: ${describeLock(before)}  ->  ${describeLock(after)}`)
  if (before) ctx.log.info('run `omd rollback` again to undo this.')
  if (running === true) ctx.log.warn('restart DSH to load it.')
}

export async function list(ctx) {
  const name = ctx.flags.profile ?? ctx.env.OMD_PROFILE ?? 'omd'
  const dir = profileDir(ctx.home, name)
  if (!existsSync(join(dir, 'package.json'))) throw new OmdError(`profile "${name}" does not exist; run \`omd setup\`.`)
  const lock = readLock(dir)
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  const { ours, user } = classifyDeps(pkg, lock)
  const rows = []
  for (const n of ours) rows.push({ name: n, version: installedVersion(dir, n) ?? '(missing)', origin: (lock.plugins[n].origin ?? []).join(','), mark: '' })
  for (const n of user) rows.push({ name: n, version: installedVersion(dir, n) ?? '(missing)', origin: 'yours', mark: '*' })
  rows.sort((a, b) => a.name.localeCompare(b.name))
  if (ctx.flags.json) { ctx.log.raw(JSON.stringify({ profile: name, lock, plugins: rows }, null, 2)); return }
  ctx.log.raw(describeLock(lock))
  const w = Math.max(...rows.map((r) => r.name.length), 6)
  for (const r of rows) ctx.log.raw(`${r.mark === '*' ? '*' : ' '} ${r.name.padEnd(w)}  ${r.version.padEnd(12)} ${c.dim(r.origin)}`)
  if (user.length > 0) ctx.log.raw(c.dim('* added by you; omd update and rollback leave these alone'))
  for (const line of describePatches(lock)) ctx.log.raw(line)
  if (lock) {
    const avail = Object.keys(lock.manifest ? {} : {})
    void avail
  }
}

/** "patched: name@version, <note>, see <issue>" for every community package omd carries a temporary fix for. */
export function describePatches(lock) {
  return Object.entries(lock?.patches ?? {}).map(([key, p]) => `patched: ${key}${p.note ? `, ${p.note}` : ''}${p.issue ? `, see ${p.issue}` : ''}`)
}

const PACK_ENV = {
  parallel: [['PARALLEL_API_KEY']],
  langfuse: [['LANGFUSE_PUBLIC_KEY'], ['LANGFUSE_SECRET_KEY']],
}

/** Health check. Prints exactly what the user still has to do; returns the list of problems and todos. */
export async function doctor(ctx, { quietHeader = false } = {}) {
  const { log } = ctx
  const problems = []
  const todos = []
  const name = ctx.flags.profile ?? ctx.env.OMD_PROFILE ?? 'omd'
  const dir = profileDir(ctx.home, name)
  if (!quietHeader) log.step(`omd doctor (profile "${name}", DSH home ${ctx.home})`)
  let manifest = null
  try { manifest = (await load(ctx, { preferLock: true })).loaded.manifest } catch (e) { log.warn(`manifest not available: ${e.message}`) }
  const lock = readLock(dir)

  const pin = manifest?.dsh ?? lock?.manifest?.dsh
  const have = dshVersion(ctx)
  const locked = lockedDsh(lock)
  if (!have) problems.push('dsh is not installed or not on PATH (run `omd setup`)')
  else if (lock && locked && have !== locked) problems.push(`dsh ${have} is installed but this profile was installed and checked with dsh ${locked} (the lock file says so): run \`omd setup\` to bring them together, or \`omd rollback\` if you just switched DSH`)
  else if (pin && have !== pin) problems.push(`dsh ${have} installed, this set was tested with ${pin} (run \`omd setup\`)`)
  else log.ok(`dsh ${have}`)

  if (!existsSync(join(dir, 'package.json'))) {
    problems.push(`profile "${name}" does not exist (run \`omd setup\`)`)
  } else {
    if (!lock) problems.push('profile has no ohmydsh.lock.json: it was not installed by omd (run `omd setup` to adopt it)')
    else log.ok(describeLock(lock))
    const missing = Object.keys(lock?.plugins ?? {}).filter((n) => !installedVersion(dir, n))
    const wrong = Object.entries(lock?.plugins ?? {}).filter(([n, p]) => { const v = installedVersion(dir, n); return v && !p.spec.startsWith('link:') && v !== p.version })
    if (missing.length > 0) problems.push(`plugins missing from node_modules: ${missing.join(', ')} (run \`omd setup\`)`)
    for (const [n, p] of wrong) problems.push(`${n}: installed ${installedVersion(dir, n)}, lock says ${p.version}`)
    if (missing.length === 0 && wrong.length === 0 && lock) log.ok(`all ${Object.keys(lock.plugins).length} plugins installed at the locked versions`)
    if (have) {
      const patchText = existsSync(join(dir, 'cordis.patch.yml')) ? readFileSync(join(dir, 'cordis.patch.yml'), 'utf8') : ''
      const check = composeCheck(ctx, { profile: name, plugins: Object.keys(lock?.plugins ?? {}), managedYaml: patchText })
      if (check.ok) log.ok('profile composes cleanly; every patch row applied')
      else for (const m of describeCompose(check)) problems.push(m)
    }
    for (const [key, p] of Object.entries(lock?.patches ?? {})) {
      const name = key.slice(0, key.lastIndexOf('@'))
      const version = key.slice(key.lastIndexOf('@') + 1)
      const bad = []
      if (installedVersion(dir, name) !== version) bad.push(`${name} is installed at ${installedVersion(dir, name) ?? '(missing)'}, not ${version}`)
      if (!existsSync(join(dir, PATCH_DIR, patchFileName(key)))) bad.push(`the patch file ${PATCH_DIR}/${patchFileName(key)} is missing`)
      if (!patchApplied(dir, key)) bad.push('pnpm-lock.yaml does not record the patch')
      if (bad.length > 0) problems.push(`patched ${key} is not in effect: ${bad.join('; ')} (run \`omd setup\`)`)
      else log.info(`patched: ${key}${p.note ? `, ${p.note}` : ''}${p.issue ? `, see ${p.issue}` : ''}`)
    }
    if (existsSync(join(dir, 'package.json'))) {
      const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
      const { user } = classifyDeps(pkg, lock)
      if (user.length > 0) log.info(`your own plugins (left alone): ${user.join(', ')}`)
    }
  }

  // Things only the user can provide. Presence checks only: credentials are never read or printed.
  const subs = join(ctx.home, 'plugins', 'subscriptions', 'auth.json')
  const hasKey = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'DEEPSEEK_API_KEY', 'GEMINI_API_KEY', 'XAI_API_KEY'].some((k) => ctx.env[k])
  if (!existsSync(subs) && !hasKey) todos.push('log in to a model: Settings > Subscriptions in the web UI (ChatGPT, Claude, Grok, Copilot, Google), or export a provider API key')
  else log.ok('a model login or API key is present')
  for (const p of lock?.packs ?? []) {
    for (const group of PACK_ENV[p] ?? []) if (!group.some((k) => ctx.env[k])) todos.push(`pack ${p}: set ${group.join(' or ')} in the environment DSH starts from`)
    if (p === 'composio' && !which('composio', ctx.env)) todos.push('pack composio: install the Composio CLI and run `composio login`')
    if (p === 'omarchy' && !which('omarchy-theme-current', ctx.env) && !existsSync(join(ctx.env.HOME ?? '', '.config', 'omarchy'))) todos.push('pack omarchy: this does not look like an Omarchy desktop; the theme plugin will have nothing to follow')
  }
  if ('@t3labs/ohmydsh-pwa' in (lock?.plugins ?? {})) log.info('phone app: needs DSH served over HTTPS (e.g. Tailscale) to install on a phone')
  if (lock) {
    const untrusted = tailnetHosts(ctx).filter((h) => !mergeHosts(lock.trustedHosts).includes(h))
    if (untrusted.length > 0) todos.push(`this machine's Tailscale name (${untrusted.join(', ')}) is not saved in the profile: after a reboot a phone or other device would load the page but stay on "Reconnecting". Run \`omd setup\` to save it.`)
    else if ((lock.trustedHosts ?? []).length > 0) log.ok(`trusted hosts saved in the profile: ${lock.trustedHosts.join(', ')}`)
  }

  for (const p of problems) log.error(p)
  for (const t of todos) log.warn(`todo: ${t}`)
  if (problems.length === 0 && todos.length === 0) log.ok('all good')
  const status = problems.length > 0 ? 1 : 0
  ctx.exitCode = Math.max(ctx.exitCode ?? 0, status)
  return { problems, todos }
}

export { diffLock, resolveDesired }
