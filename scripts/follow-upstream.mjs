#!/usr/bin/env node
// Follow DeepSeek Harness and the community plugins: find newer versions, pin them, write the release notes.
//
//   node scripts/follow-upstream.mjs --list [--hold a,b] [--skip name@ver,...] [--only name@ver] [--min-age-hours N]
//       print JSON { candidates, held, skipped, errors }; candidates are the newest `latest` of @deepseek-ai/dsh and of
//       every community plugin in ohmydsh.json (our own packages, the `sources`, are never candidates)
//   node scripts/follow-upstream.mjs --apply name@ver [name@ver...]
//       pin them in ohmydsh.json (and every other place the DSH pin is written down); prints JSON of what changed
//   node scripts/follow-upstream.mjs --release-notes name@ver [name@ver...]
//       after --apply: bump ohmydsh.json, packages/cli and apps/desktop to the next patch version and add the CHANGELOG
//       section listing each bump (the bumps are the specs given, compared with the previous pins in git HEAD)
//   --root DIR   operate on another checkout (tests)
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { applyPins, applyReleaseNotes, findCandidates, nextPatch, splitSpec } from './lib/follow.mjs'

const args = process.argv.slice(2)
const flag = (name) => { const i = args.indexOf(name); return i === -1 ? undefined : args[i + 1] }
const has = (name) => args.includes(name)
const rest = (name) => { const i = args.indexOf(name); if (i === -1) return []; const out = []; for (const a of args.slice(i + 1)) { if (a.startsWith('--')) break; out.push(a) } return out }
const csv = (v) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : [])
const root = resolve(flag('--root') ?? join(dirname(fileURLToPath(import.meta.url)), '..'))

const registry = (process.env.npm_config_registry ?? 'https://registry.npmjs.org').replace(/\/$/, '')
async function fetchPackument(name, minAge) {
  const res = await fetch(`${registry}/${name.replace('/', '%2F')}`, { headers: { accept: minAge ? 'application/json' : 'application/vnd.npm.install-v1+json' }, signal: AbortSignal.timeout(60_000) })
  if (!res.ok) throw new Error(`registry answered HTTP ${res.status}`)
  return res.json()
}

/** The pins as they are in git HEAD, to compute the bumps for the release notes. */
function pinsInHead() {
  const r = spawnSync('git', ['show', 'HEAD:ohmydsh.json'], { cwd: root, encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`cannot read ohmydsh.json from git HEAD: ${r.stderr.trim()}`)
  return JSON.parse(r.stdout)
}

try {
  if (has('--list')) {
    const manifest = JSON.parse(readFileSync(join(root, 'ohmydsh.json'), 'utf8'))
    const minAgeHours = Number(flag('--min-age-hours') ?? 0)
    const out = await findCandidates(manifest, { fetchPackument: (n) => fetchPackument(n, minAgeHours > 0), hold: csv(flag('--hold')), skip: csv(flag('--skip')), only: flag('--only'), minAgeHours })
    process.stdout.write(`${JSON.stringify(out, null, 2)}\n`)
    if (out.errors.length > 0 && out.candidates.length === 0 && flag('--only')) process.exit(1)
  } else if (has('--apply')) {
    const specs = rest('--apply')
    if (specs.length === 0) throw new Error('usage: --apply name@version [name@version...]')
    process.stdout.write(`${JSON.stringify(applyPins(root, specs), null, 2)}\n`)
  } else if (has('--release-notes')) {
    const specs = rest('--release-notes')
    if (specs.length === 0) throw new Error('usage: --release-notes name@version [name@version...]')
    const head = pinsInHead()
    const bumps = []
    for (const s of specs) {
      const { name, version } = splitSpec(s)
      if (name === '@deepseek-ai/dsh') { if (head.dsh !== version) bumps.push({ name, kind: 'dsh', from: head.dsh, to: version }); continue }
      const before = [head.plugins.core, ...Object.values(head.plugins.packs)].map((m) => m[name]).find(Boolean)
      if (before && before !== version) bumps.push({ name, kind: 'plugin', from: before, to: version })
    }
    if (bumps.length === 0) throw new Error('no pin differs from git HEAD: nothing to release')
    const version = nextPatch(head.version) // always from the released manifest, so re-running does not bump twice
    const files = applyReleaseNotes(root, bumps, version)
    process.stdout.write(`${JSON.stringify({ version, bumps, files }, null, 2)}\n`)
  } else {
    process.stderr.write('usage: follow-upstream.mjs --list | --apply name@ver... | --release-notes name@ver...\n')
    process.exit(2)
  }
} catch (e) {
  process.stderr.write(`follow-upstream: ${e.message}\n`)
  process.exit(1)
}
