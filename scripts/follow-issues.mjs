#!/usr/bin/env node
// The GitHub side of following: which packages are on hold, which exact versions already failed, and opening, updating
// and closing the `follow` issues after a run. Needs the `gh` CLI with GH_TOKEN (issues: write).
//
//   node scripts/follow-issues.mjs --state                       print JSON { hold: [names], skip: ["name@version"] }
//   node scripts/follow-issues.mjs --sync result.json [--run-url URL] [--dry-run]
//        result.json: { passed: [...], failed: [...] } (scripts/follow-run.mjs, merged over operating systems)
//   --pins FILE   JSON { name: version } of the pins now in the manifest (default: read ohmydsh.json)
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { FOLLOW_LABEL, HOLD_LABEL, externalPlugins, issuePackage, parseIssueTitle, planIssueActions } from './follow-lib/follow.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const flag = (n) => { const i = args.indexOf(n); return i === -1 ? undefined : args[i + 1] }
const has = (n) => args.includes(n)
const dry = has('--dry-run')

function gh(a, input) {
  const r = spawnSync('gh', a, { encoding: 'utf8', input, maxBuffer: 64 * 1024 * 1024 })
  if (r.status !== 0) throw new Error(`gh ${a.slice(0, 3).join(' ')} failed: ${(r.stderr || r.stdout).trim().slice(-500)}`)
  return r.stdout
}

function ensureLabels() {
  for (const [name, color, description] of [[FOLLOW_LABEL, '1d76db', 'Automatic follow of DeepSeek Harness and community plugins'], [HOLD_LABEL, 'fbca04', 'Keep the package at its pinned version (use with a "follow: <package> hold" issue)']]) {
    spawnSync('gh', ['label', 'create', name, '--color', color, '--description', description], { encoding: 'utf8' }) // exists already: fine
  }
}

function openIssues() {
  const out = JSON.parse(gh(['issue', 'list', '--label', FOLLOW_LABEL, '--state', 'open', '--limit', '200', '--json', 'number,title,labels']))
  return out.map((i) => ({ number: i.number, title: i.title, labels: i.labels.map((l) => l.name) }))
}

try {
  if (has('--state')) {
    const issues = openIssues()
    const hold = [...new Set(issues.filter((i) => i.labels.includes(HOLD_LABEL)).map((i) => issuePackage(i.title)).filter(Boolean))]
    const skip = issues.filter((i) => !i.labels.includes(HOLD_LABEL)).map((i) => parseIssueTitle(i.title)).filter(Boolean).map((t) => `${t.name}@${t.version}`)
    process.stdout.write(`${JSON.stringify({ hold, skip })}\n`)
  } else if (flag('--sync')) {
    const result = JSON.parse(readFileSync(flag('--sync'), 'utf8'))
    const manifest = JSON.parse(readFileSync(join(root, 'ohmydsh.json'), 'utf8'))
    const pins = flag('--pins') ? JSON.parse(readFileSync(flag('--pins'), 'utf8')) : { '@deepseek-ai/dsh': manifest.dsh, ...Object.fromEntries([...externalPlugins(manifest)].map(([n, v]) => [n, v.version])) }
    const plan = planIssueActions({ openIssues: openIssues(), passed: result.passed, failed: result.failed, pins, runUrl: flag('--run-url') })
    process.stdout.write(`${JSON.stringify({ create: plan.create.map((c) => c.title), update: plan.update.map((u) => u.number), close: plan.close.map((c) => c.number) })}\n`)
    if (!dry) {
      if (plan.create.length > 0) ensureLabels()
      for (const c of plan.create) gh(['issue', 'create', '--title', c.title, '--body-file', '-', '--label', FOLLOW_LABEL], c.body)
      for (const u of plan.update) { gh(['issue', 'edit', String(u.number), '--title', u.title, '--body-file', '-'], u.body); gh(['issue', 'comment', String(u.number), '--body', u.comment]) }
      for (const c of plan.close) gh(['issue', 'close', String(c.number), '--comment', c.comment])
    }
  } else {
    process.stderr.write('usage: follow-issues.mjs --state | --sync result.json [--run-url URL] [--dry-run]\n')
    process.exit(2)
  }
} catch (e) {
  process.stderr.write(`follow-issues: ${e.message}\n`)
  process.exit(1)
}
