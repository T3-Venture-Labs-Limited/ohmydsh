#!/usr/bin/env node
// Decide what may be released from a list of candidates, by running the gate (scripts/gate.mjs): all of them together;
// if that is red, DSH alone and every plugin alone; then the passing subset together once more. Leaves the working tree
// with exactly the passing subset pinned (ohmydsh.json, the other DSH pins, CHANGELOG, versions, pnpm-lock.yaml), ready to
// commit, or untouched when nothing passes.
//
//   node scripts/follow-run.mjs --candidates "name@ver name@ver" --out result.json [--work DIR] [--port-base 43300]
//        [--gate-args "--skip-checks"]
//
// Result: { passed: ["name@ver"], failed: [{ spec, name, version, step, class, message, tail }], runs: [...], version }
// A failed entry with class "needs-human" means an install script nobody approved, or (reason "patched") a new version
// of a package ohmydsh.json carries a patch for, which a human must look at first (it is not even run through the gate); "combination" means every candidate
// passes alone but not together (nothing is released then).
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DSH, screenPatched, splitSpec } from './follow-lib/follow.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const flag = (n, d) => { const i = args.indexOf(n); return i === -1 ? d : args[i + 1] }
const specs = (flag('--candidates', '') ?? '').split(/\s+/).filter(Boolean)
const out = resolve(flag('--out', join(root, '.tmp', 'follow-result.json')))
const work = resolve(flag('--work', join(root, '.tmp', 'follow')))
const portBase = Number(flag('--port-base', 43300))
const gateArgs = (flag('--gate-args', '') ?? '').split(/\s+/).filter(Boolean)
if (specs.length === 0) { process.stderr.write('usage: follow-run.mjs --candidates "name@ver ..." --out file\n'); process.exit(2) }

const git = (a) => spawnSync('git', a, { cwd: root, encoding: 'utf8' })
const dirty = git(['status', '--porcelain']).stdout.trim()
if (dirty) { process.stderr.write(`follow-run: the working tree must be clean (it is reset between runs):\n${dirty}\n`); process.exit(2) }
const reset = () => { const r = git(['checkout', '--', '.']); if (r.status !== 0) throw new Error(`git checkout failed: ${r.stderr}`) }

rmSync(work, { recursive: true, force: true })
mkdirSync(work, { recursive: true })
const runs = []
let n = 0

function gate(label, set) {
  reset()
  const dir = join(work, `${String(++n).padStart(2, '0')}-${label.replace(/[^\w.@-]+/g, '_')}`)
  const result = join(dir, 'gate-result.json')
  process.stdout.write(`\n######## gate: ${label} (${set.join(' ')})\n`)
  const r = spawnSync('node', [join(root, 'scripts/gate.mjs'), '--candidates', set.join(' '), '--work', dir, '--result', result, '--port-base', String(portBase + n * 6), ...gateArgs], { cwd: root, stdio: 'inherit', env: process.env })
  let res
  try { res = JSON.parse(readFileSync(result, 'utf8')) } catch { res = { ok: false, failed: { step: 'gate', class: 'failure', message: `the gate crashed (exit ${r.status})`, tail: '' } } }
  runs.push({ label, set, ok: res.ok, step: res.failed?.step ?? null })
  return res
}

const entry = (spec, res, extra = {}) => ({ spec, ...splitSpec(spec), step: res.failed?.step, class: res.failed?.class ?? 'failure', ...(res.failed?.reason ? { reason: res.failed.reason } : {}), message: res.failed?.message, tail: res.failed?.tail, ...extra })

let passed = []
const failed = []
// A candidate that moves a patched package is not tested: the patch would stop applying to it, so a human decides.
const { testable, blocked } = screenPatched(JSON.parse(readFileSync(join(root, 'ohmydsh.json'), 'utf8')), specs)
failed.push(...blocked)
if (testable.length > 0) {
  const all = gate('all', testable)
  if (all.ok) passed = [...testable]
  else if (testable.length === 1) failed.push(entry(testable[0], all))
  else {
    const order = [...testable.filter((s) => splitSpec(s).name === DSH), ...testable.filter((s) => splitSpec(s).name !== DSH)]
    for (const s of order) {
      const r = gate(s, [s])
      if (r.ok) passed.push(s)
      else failed.push(entry(s, r))
    }
    if (passed.length > 1) {
      const combo = gate('passing-together', passed)
      if (!combo.ok) {
        failed.push({ spec: passed.join(' '), name: 'combination', version: '', step: combo.failed?.step, class: 'combination', message: `${passed.join(', ')} each pass alone but not together`, tail: combo.failed?.tail })
        passed = []
      }
    }
  }
}

// Leave the tree with the passing subset pinned.
reset()
let version = null
if (passed.length > 0) {
  const sh = (cmd, a) => { const r = spawnSync(cmd, a, { cwd: root, encoding: 'utf8' }); if (r.status !== 0) throw new Error(`${cmd} ${a.join(' ')} failed:\n${r.stdout}${r.stderr}`); return r.stdout }
  sh('node', ['scripts/follow-upstream.mjs', '--apply', ...passed])
  version = JSON.parse(sh('node', ['scripts/follow-upstream.mjs', '--release-notes', ...passed])).version
  sh('pnpm', ['install', '--no-frozen-lockfile'])
  sh('pnpm', ['install', '--frozen-lockfile']) // release.yml installs frozen: the committed lockfile must satisfy it
}
const result = { passed, failed, runs, version }
mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`)
process.stdout.write(`\nfollow-run: ${passed.length} passed, ${failed.length} failed -> ${out}\n`)
