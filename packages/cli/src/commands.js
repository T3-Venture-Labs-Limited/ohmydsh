// The omd commands. Every command takes a ctx so tests can inject the process runner and paths.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { composeCheck, describeCompose, dshVersion, installedVersion, isProfileRunning } from './health.js'
import { classifyDeps, diffLock, readLock } from './lock.js'
import { defaultManifestSource, loadManifest, packNames, resolveDesired } from './manifest.js'
import { describeLock, prevName, profileDir, rollbackSwap, syncProfile } from './profile.js'
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

/** Make sure the pinned DSH is installed. Never touches a running DSH. */
export function ensureDsh(ctx, manifest) {
  const have = dshVersion(ctx)
  if (have === manifest.dsh) return { version: have, changed: false }
  if (ctx.flags['no-dsh-install']) {
    ctx.log.warn(`DSH ${have ?? '(not found)'} is installed, ohmydsh was tested with ${manifest.dsh}. Skipping the install (--no-dsh-install).`)
    return { version: have, changed: false }
  }
  ctx.log.step(`installing DeepSeek Harness ${manifest.dsh}`)
  const spec = `@deepseek-ai/dsh@${manifest.dsh}`
  const r = which('mise', ctx.env) ? ctx.run('mise', ['use', '-g', `npm:${spec}`], { env: ctx.env }) : ctx.run('npm', ['install', '-g', spec], { env: ctx.env })
  if (r.error || r.status !== 0) throw new OmdError(`could not install ${spec}:\n${(r.error?.message ?? r.stderr).trim().split('\n').slice(-8).join('\n')}\n  Install it yourself and re-run (npm install -g ${spec}).`)
  const now = dshVersion(ctx)
  if (now !== manifest.dsh) throw new OmdError(`installed ${spec} but \`dsh --version\` reports ${now ?? 'nothing'}; check your PATH.`)
  return { version: now, changed: true }
}

export async function setup(ctx) {
  const { loaded, name } = await load(ctx, { preferLock: true })
  const { manifest } = loaded
  if (Number(process.versions.node.split('.')[0]) < 24) throw new OmdError(`Node ${process.versions.node} is too old; ohmydsh needs Node 24 or newer.`)
  ctx.log.step(`ohmydsh ${manifest.version} for DSH ${manifest.dsh}${ctx.flags.dev ? ' (dev links)' : ''}`)
  ensureDsh(ctx, manifest)
  const lock = readLock(profileDir(ctx.home, name))
  const packs = [...new Set([...(lock?.packs ?? []), ...splitList(ctx.flags.pack)])]
  const res = await syncProfile(ctx, { loaded, name, packs, dev: Boolean(ctx.flags.dev) || Boolean(lock?.dev && !ctx.flags.manifest), force: Boolean(ctx.flags.force), bootCheck: Boolean(ctx.flags['boot-check']) })
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
  const res = await syncProfile(ctx, { loaded, name, packs, dev: lock.dev, force: Boolean(ctx.flags.force), bootCheck: Boolean(ctx.flags['boot-check']) })
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
  if (lock.manifest.dsh !== manifest.dsh) ctx.log.warn(`this set needs DSH ${manifest.dsh} (you have ${dshVersion(ctx) ?? 'none'}); omd update does not swap the DSH binary, run \`omd setup\` for that.`)
  const dev = ctx.flags.dev !== undefined ? Boolean(ctx.flags.dev) : lock.dev
  const res = await syncProfile(ctx, { loaded, name, packs: lock.packs, dev, dryRun: Boolean(ctx.flags['dry-run']), force: Boolean(ctx.flags.force), bootCheck: Boolean(ctx.flags['boot-check']) })
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
  if (lock) {
    const avail = Object.keys(lock.manifest ? {} : {})
    void avail
  }
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
  if (!have) problems.push('dsh is not installed or not on PATH (run `omd setup`)')
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
  if ('dsh-pwa' in (lock?.plugins ?? {})) log.info('phone app: needs DSH served over HTTPS (e.g. Tailscale) to install on a phone')

  for (const p of problems) log.error(p)
  for (const t of todos) log.warn(`todo: ${t}`)
  if (problems.length === 0 && todos.length === 0) log.ok('all good')
  const status = problems.length > 0 ? 1 : 0
  ctx.exitCode = Math.max(ctx.exitCode ?? 0, status)
  return { problems, todos }
}

export { diffLock, resolveDesired }
