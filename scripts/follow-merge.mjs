#!/usr/bin/env node
// Merge the follow-run results of the operating systems: a candidate is released only if it passed on every one.
//   node scripts/follow-merge.mjs --in DIR --out merged.json [--expect ubuntu-latest,macos-latest]
//       DIR holds <prefix>-result-<os>/follow-result.json files; a missing expected OS is an error (never release on half the evidence)
// Prints a markdown summary (also for $GITHUB_STEP_SUMMARY) and writes { passed, failed, version }.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { mergeResults } from './follow-lib/follow.mjs'

const args = process.argv.slice(2)
const flag = (n) => { const i = args.indexOf(n); return i === -1 ? undefined : args[i + 1] }
const dir = resolve(flag('--in') ?? '.')
const out = resolve(flag('--out') ?? 'merged.json')
const runs = []
for (const d of readdirSync(dir).sort()) {
  const f = join(dir, d, 'follow-result.json')
  if (existsSync(f)) runs.push({ os: d.replace(/^.*result-/, ''), result: JSON.parse(readFileSync(f, 'utf8')) })
}
const expect = (flag('--expect') ?? '').split(',').filter(Boolean)
const missing = expect.filter((os) => !runs.some((r) => r.os === os))
if (missing.length > 0) { process.stderr.write(`follow-merge: no result from ${missing.join(', ')}\n`); process.exit(1) }
if (runs.length === 0) { process.stderr.write(`follow-merge: no results under ${dir}\n`); process.exit(1) }
const merged = { ...mergeResults(runs), version: runs.find((r) => r.result.version)?.result.version ?? null, oses: runs.map((r) => r.os) }
// Does the release set equal what every OS tested as its passing set? If not, the release job runs the gate once more on it.
merged.tested = runs.every(({ result }) => result.passed.length === merged.passed.length && result.passed.every((s) => merged.passed.includes(s)))
mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, `${JSON.stringify(merged, null, 2)}\n`)
const md = ['### Follow result', '', `Operating systems: ${merged.oses.join(', ')}`, '', `Released: ${merged.passed.length === 0 ? 'nothing' : merged.passed.map((s) => `\`${s}\``).join(', ')}`, '', ...merged.failed.map((f) => `- FAIL \`${f.spec}\`${f.os ? ` (${f.os})` : ''}: ${f.step ?? '?'}${f.class === 'needs-human' ? ' (an install script needs a human review)' : ''}`)].join('\n')
process.stdout.write(`${md}\n`)
