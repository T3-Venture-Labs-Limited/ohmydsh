#!/usr/bin/env node
// The release gate: everything that must be true before a set of versions may ship. CI, the release workflow and the
// follow workflow all run this one script, so "green" means the same thing everywhere.
//
//   node scripts/gate.mjs [--work DIR] [--port-base 43300] [--result FILE]
//        [--candidates "n@v n@v"]  first pin these versions (scripts/follow-upstream.mjs --apply and --release-notes, so the
//                           manifest is the next patch release), then run everything against that manifest; the
//                           workspace is installed with --no-frozen-lockfile because a DSH pin moves devDependencies.
//                           `pnpm -r run check` runs only when DSH itself is a candidate (a community plugin cannot
//                           change our packages' typecheck or tests); the set is still installed, booted and upgraded.
//        [--skip-install]   the workspace is already installed (pnpm install --frozen-lockfile is skipped)
//        [--skip-checks]    skip `pnpm -r run check` (the workflow runs it on one OS only)
//        [--skip-upgrade]   skip the upgrade-path step
//        [--previous X.Y.Z] released ohmydsh to upgrade from (default: @t3labs/ohmydsh `latest` on npm)
//        [--repo owner/name] repository the released manifest is read from (default $GITHUB_REPOSITORY)
//
// Steps: install, checks, manifest, private strings, build, pack audit, `omd setup` from the packed tarballs into a clean
// DSH home with the manifest's DSH installed by omd itself, composed config, web boot, every pack added and still clean,
// `omd update` from the previously released ohmydsh to this one (the upgrade real users take) and boot again, rollback
// and roll forward. Every child process gets a throwaway HOME and DSH_HOME, so the machine's own DSH is never touched.
//
// Result file (default <work>/gate-result.json): { ok, steps: [{ name, ok, seconds }], failed: { step, class, tail } }
// class "needs-human": pnpm refused an install script nobody approved (never approved automatically).
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { delimiter, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describeCompose, dumpedBundles, parseProblems, parseUnapplied } from '../packages/cli/src/health.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const flag = (n, d) => { const i = args.indexOf(n); return i === -1 ? d : args[i + 1] }
const has = (n) => args.includes(n)
const work = resolve(flag('--work', join(root, '.tmp', 'gate')))
const portBase = Number(flag('--port-base', 43300))
const resultFile = resolve(flag('--result', join(work, 'gate-result.json')))
const repo = flag('--repo', process.env.GITHUB_REPOSITORY ?? 'T3-Venture-Labs-Limited/ohmydsh')
const candidates = (flag('--candidates', '') ?? '').split(/\s+/).filter(Boolean)
const withDsh = candidates.some((c) => c.startsWith('@deepseek-ai/dsh@'))
let manifest = JSON.parse(readFileSync(join(root, 'ohmydsh.json'), 'utf8'))
const PACKS = Object.keys(manifest.plugins.packs).sort()
const BAD_BOOT = /failed to import|startup failed|fatal load failure|did not activate|client bundle not found/i
const IGNORED_BUILDS = /ERR_PNPM_IGNORED_BUILDS|Ignored build scripts/i

rmSync(work, { recursive: true, force: true })
mkdirSync(work, { recursive: true })

// Caches: keep the caller's (CI cache, or the local isolated ones) even though HOME is replaced below.
const probe = (cmd, a) => { const r = spawnSync(cmd, a, { encoding: 'utf8' }); return r.status === 0 ? r.stdout.trim() : '' }
const npmCache = process.env.npm_config_cache || probe('npm', ['config', 'get', 'cache'])
const pnpmStore = process.env.npm_config_store_dir || probe('pnpm', ['store', 'path'])

function envFor(name, extra = {}) {
  const home = join(work, name, 'home')
  const prefix = join(work, name, 'prefix')
  mkdirSync(home, { recursive: true })
  mkdirSync(prefix, { recursive: true })
  const env = { ...process.env, HOME: home, USERPROFILE: home, DSH_HOME: join(work, name, 'dsh'), npm_config_prefix: prefix, OMD_DSH_INSTALLER: 'npm', PNPM_HOME: join(work, name, 'pnpm-home'), CI: 'true', ...extra }
  if (npmCache) env.npm_config_cache = npmCache
  if (pnpmStore) env.npm_config_store_dir = pnpmStore
  for (const k of Object.keys(env)) if (/^(OHMYDSH_|OMD_)/.test(k) && k !== 'OMD_DSH_INSTALLER' || (/^DSH_/.test(k) && k !== 'DSH_HOME')) delete env[k]
  // npm -g puts bins in <prefix>/bin on POSIX and in <prefix> on Windows; this gate targets Linux and macOS runners.
  env.PATH = `${join(prefix, 'bin')}${delimiter}${process.env.PATH}`
  return env
}

let current = ''
function sh(cmd, a, { env = process.env, cwd = root, log, timeoutMs = 20 * 60_000 } = {}) {
  const file = join(work, 'logs', `${log ?? `${current}-${cmd}`}.log`.replace(/[^\w./-]+/g, '_'))
  mkdirSync(dirname(file), { recursive: true })
  const r = spawnSync(cmd, a, { cwd, env, encoding: 'utf8', maxBuffer: 512 * 1024 * 1024, timeout: timeoutMs })
  const text = `$ ${cmd} ${a.join(' ')}\n${r.stdout ?? ''}${r.stderr ?? ''}${r.error ? `\n[spawn error] ${r.error.message}\n` : ''}\n[exit ${r.status}]\n`
  writeFileSync(file, text)
  process.stdout.write(`    $ ${cmd} ${a.join(' ')}  -> exit ${r.status}\n`)
  return { status: r.status, text, stdout: r.stdout ?? '', stderr: r.stderr ?? '', file }
}

class StepError extends Error {
  constructor(message, text = '') { super(message); this.text = text }
}
function must(r, what) {
  if (r.status !== 0) throw new StepError(`${what} failed (exit ${r.status})`, r.text)
  return r
}

const omd = (env, a, o) => sh('node', [join(root, 'packages/cli/bin/omd.js'), ...a], { env, ...o })

function checkCompose(env, label, { packs = [] } = {}) {
  const r = sh('dsh', ['--profile', 'omd', '--dump-config'], { env, log: `${current}-dump-${label}` })
  if (r.status !== 0) throw new StepError(`dsh --dump-config failed (${label})`, r.text)
  const want = [...Object.keys(manifest.plugins.core), ...packs.flatMap((p) => Object.keys(manifest.plugins.packs[p]))]
  const dumped = dumpedBundles(r.stdout)
  const res = { unapplied: parseUnapplied(r.stderr), errors: parseProblems(r.stderr), missingBundles: want.filter((n) => !dumped.has(n)), missingRows: [] }
  for (const id of ['studio', 'dsh-pwa']) if (!new RegExp(`^- id: ${id}$`, 'm').test(r.stdout)) res.missingRows.push(id)
  const problems = describeCompose(res)
  if (problems.length > 0) throw new StepError(`the composed config is not clean (${label}): ${problems.join('; ')}`, r.text)
}

function checkDoctor(env, label) {
  const r = omd(env, ['doctor'], { log: `${current}-doctor-${label}` })
  if (r.status !== 0) throw new StepError(`omd doctor reports problems (${label})`, r.text)
  const list = omd(env, ['list'], { log: `${current}-list-${label}` })
  if (list.status !== 0) throw new StepError(`omd list failed (${label})`, list.text)
}

let ports = 0
async function checkBoot(env, label) {
  const port = portBase + ports++
  const file = join(work, 'logs', `${current}-boot-${label}.log`.replace(/[^\w./-]+/g, '_'))
  mkdirSync(dirname(file), { recursive: true })
  const child = spawn('dsh', ['omd', '--no-open', '--port', String(port)], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  let text = ''
  child.stdout.on('data', (d) => { text += d })
  child.stderr.on('data', (d) => { text += d })
  const spawnErr = new Promise((res) => child.on('error', (e) => { text += `\n[spawn error] ${e.message}\n`; res() }))
  const started = Date.now()
  while (Date.now() - started < 90_000 && !/dsh web: http/.test(text) && child.exitCode === null) await Promise.race([new Promise((r) => setTimeout(r, 500)), spawnErr])
  const served = /dsh web: http/.test(text)
  if (served) await new Promise((r) => setTimeout(r, 6000))
  child.kill('SIGTERM')
  await new Promise((r) => { child.once('exit', r); setTimeout(() => { child.kill('SIGKILL'); r() }, 8000).unref() })
  writeFileSync(file, text)
  process.stdout.write(`    boot (${label}) on :${port}: ${served ? 'served' : 'NOT served'}\n`)
  if (!served) throw new StepError(`the web server did not start (${label})`, text)
  const bad = text.split('\n').filter((l) => BAD_BOOT.test(l))
  if (bad.length > 0) throw new StepError(`plugin load failures on boot (${label}): ${bad.slice(0, 3).join(' | ')}`, text)
}

const dshOf = (env) => { const r = spawnSync('dsh', ['--version'], { env, encoding: 'utf8' }); return r.status === 0 ? r.stdout.trim().split('\n').pop().trim() : null }

const tarManifest = join(root, '.tmp', 'tarballs', 'ohmydsh.json')
let previous = flag('--previous')

const steps = []
const add = (name, fn, { skip = false } = {}) => steps.push({ name, fn, skip })

add('pin the candidates', () => {
  if (candidates.length === 0) return
  const r = must(sh('node', ['scripts/follow-upstream.mjs', '--apply', ...candidates]), 'pinning the candidates')
  must(sh('node', ['scripts/follow-upstream.mjs', '--release-notes', ...candidates]), 'writing the release notes')
  void r
  manifest = JSON.parse(readFileSync(join(root, 'ohmydsh.json'), 'utf8'))
  process.stdout.write(`    manifest is now ohmydsh ${manifest.version} on DSH ${manifest.dsh}\n`)
})
add('install workspace', () => {
  if (has('--skip-install')) return
  must(sh('pnpm', ['install', candidates.length > 0 ? '--no-frozen-lockfile' : '--frozen-lockfile']), 'pnpm install')
})
add('pnpm -r run check', () => must(sh('pnpm', ['-r', 'run', 'check'], { timeoutMs: 40 * 60_000 }), 'pnpm -r run check'), { skip: has('--skip-checks') || (candidates.length > 0 && !withDsh) })
add('check:manifest', () => must(sh('pnpm', ['run', 'check:manifest']), 'check:manifest'))
add('check:private', () => must(sh('node', ['scripts/check-private-strings.mjs']), 'check:private'))
add('build', () => must(sh('pnpm', ['run', 'build']), 'pnpm run build'))
add('pack audit', () => must(sh('node', ['scripts/pack-all.mjs']), 'pack audit'))

add('setup from tarballs (fresh home, DSH installed by omd)', async () => {
  const env = envFor('fresh')
  const r = omd(env, ['setup', '--manifest', tarManifest], { log: 'fresh-setup' })
  if (IGNORED_BUILDS.test(r.text)) throw new StepError('pnpm blocked an install script that is not approved in ohmydsh.json allowBuilds', r.text)
  must(r, 'omd setup')
  if (dshOf(env) !== manifest.dsh) throw new StepError(`omd setup left DSH at ${dshOf(env)}, the manifest pins ${manifest.dsh}`, r.text)
  if (readFileSync(join(env.DSH_HOME, 'profiles/omd/ohmydsh.lock.json'), 'utf8').includes('"link:')) throw new StepError('a plugin was linked, not installed from its tarball', '')
  checkCompose(env, 'core')
  checkDoctor(env, 'core')
  await checkBoot(env, 'core')
})

add('add every pack, still clean', async () => {
  const env = envFor('fresh')
  for (const p of PACKS) {
    const r = omd(env, ['add', p], { log: `fresh-add-${p}` })
    if (IGNORED_BUILDS.test(r.text)) throw new StepError(`pnpm blocked an install script while adding the ${p} pack (not approved in allowBuilds)`, r.text)
    must(r, `omd add ${p}`)
  }
  checkCompose(env, 'packs', { packs: PACKS })
  checkDoctor(env, 'packs')
  await checkBoot(env, 'packs')
})

add('setup --dev (workspace links)', () => {
  const env = envFor('dev')
  const r = omd(env, ['setup', '--dev'], { log: 'dev-setup' })
  if (IGNORED_BUILDS.test(r.text)) throw new StepError('pnpm blocked an install script that is not approved in ohmydsh.json allowBuilds', r.text)
  must(r, 'omd setup --dev')
  checkCompose(env, 'dev')
})

add('upgrade from the previous release (omd update)', async () => {
  if (has('--skip-upgrade')) return
  if (!previous) {
    const r = spawnSync('npm', ['view', '@t3labs/ohmydsh', 'version'], { encoding: 'utf8' })
    previous = r.status === 0 ? r.stdout.trim().split('\n').pop().trim() : ''
  }
  if (!previous) throw new StepError('cannot find the previously released @t3labs/ohmydsh on npm', '')
  if (previous === manifest.version) { process.stdout.write(`    the manifest version ${previous} is already released: nothing to upgrade from\n`); return }
  process.stdout.write(`    upgrading from released ohmydsh ${previous} to ${manifest.version}\n`)
  const env = envFor('upgrade')
  // 1. the released CLI from npm sets up the released set (its manifest at its tag), packs included
  must(sh('npm', ['install', '-g', `@t3labs/ohmydsh@${previous}`, '--no-audit', '--no-fund'], { env, log: 'upgrade-install-old-cli' }), 'npm install of the released omd')
  const oldManifest = `https://raw.githubusercontent.com/${repo}/v${previous}/ohmydsh.json`
  // Install the DSH the released set was tested with ourselves (npm, into the throwaway prefix), as a user already has it.
  const oldDsh = await (await fetch(oldManifest)).json().then((m) => m.dsh).catch(() => null)
  if (!oldDsh) throw new StepError(`cannot read ${oldManifest}`, '')
  must(sh('npm', ['install', '-g', `@deepseek-ai/dsh@${oldDsh}`, '--no-audit', '--no-fund'], { env, log: 'upgrade-install-old-dsh' }), `npm install of DSH ${oldDsh}`)
  const old = sh('omd', ['setup', '--no-dsh-install', '--manifest', oldManifest, '--pack', PACKS.join(',')], { env, log: 'upgrade-old-setup', timeoutMs: 30 * 60_000 })
  if (old.status !== 0) throw new StepError(`the released ohmydsh ${previous} could not be set up (this is the starting point, not the candidate)`, old.text)
  const dshBefore = dshOf(env)
  // 2. this checkout's omd moves the profile and DSH to the candidate manifest
  const up = omd(env, ['update', '--manifest', tarManifest], { log: 'upgrade-update', timeoutMs: 30 * 60_000 })
  if (IGNORED_BUILDS.test(up.text)) throw new StepError('pnpm blocked an install script during omd update (not approved in allowBuilds)', up.text)
  must(up, 'omd update')
  if (dshOf(env) !== manifest.dsh) throw new StepError(`after omd update DSH is ${dshOf(env)}, the manifest pins ${manifest.dsh}`, up.text)
  checkCompose(env, 'upgraded', { packs: PACKS })
  checkDoctor(env, 'upgraded')
  await checkBoot(env, 'upgraded')
  // 3. rollback returns to the old pair, and again to the new one
  const back = omd(env, ['rollback'], { log: 'upgrade-rollback' })
  must(back, 'omd rollback')
  if (dshOf(env) !== dshBefore) throw new StepError(`omd rollback left DSH at ${dshOf(env)}, expected ${dshBefore}`, back.text)
  checkCompose(env, 'rolled-back', { packs: PACKS })
  must(omd(env, ['rollback'], { log: 'upgrade-rollforward' }), 'omd rollback (forward again)')
  if (dshOf(env) !== manifest.dsh) throw new StepError(`rolling forward left DSH at ${dshOf(env)}`, '')
  checkCompose(env, 'rolled-forward', { packs: PACKS })
})

const results = []
let failed = null
for (const s of steps) {
  if (s.skip) { process.stdout.write(`-- skip ${s.name}\n`); results.push({ name: s.name, ok: true, skipped: true, seconds: 0 }); continue }
  current = s.name.replace(/[^\w]+/g, '-').slice(0, 24)
  process.stdout.write(`== ${s.name}\n`)
  const t0 = Date.now()
  try {
    await s.fn()
    results.push({ name: s.name, ok: true, seconds: Math.round((Date.now() - t0) / 1000) })
  } catch (e) {
    const text = e.text ?? ''
    const needsHuman = IGNORED_BUILDS.test(text) || IGNORED_BUILDS.test(e.message)
    failed = { step: s.name, class: needsHuman ? 'needs-human' : 'failure', message: e.message, tail: text.trim().split('\n').slice(-40).join('\n') }
    results.push({ name: s.name, ok: false, seconds: Math.round((Date.now() - t0) / 1000) })
    process.stdout.write(`!! ${s.name}: ${e.message}\n${failed.tail}\n`)
    break
  }
}
const out = { ok: failed === null, dsh: manifest.dsh, version: manifest.version, previous: previous ?? null, steps: results, failed }
writeFileSync(resultFile, `${JSON.stringify(out, null, 2)}\n`)
process.stdout.write(`\n${out.ok ? 'GATE PASSED' : `GATE FAILED at "${failed.step}"${failed.class === 'needs-human' ? ' (needs a human: an install script must be reviewed)' : ''}`}  (result: ${resultFile})\n`)
for (const r of results) process.stdout.write(`   ${r.ok ? (r.skipped ? 'skip' : 'ok  ') : 'FAIL'} ${String(r.seconds).padStart(4)}s  ${r.name}\n`)
process.exit(out.ok ? 0 : 1)
