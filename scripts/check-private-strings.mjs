#!/usr/bin/env node
// Fails when anything that must never be public shows up in the tracked tree, in commit messages, or in commit
// identities. Adapted from the publish audit of the original plugin repos. The patterns are assembled from pieces so
// this file does not match itself.
//
//   node scripts/check-private-strings.mjs            # tree + all history reachable from HEAD
//   node scripts/check-private-strings.mjs --tree     # tree only
//   OMD_ALLOWED_IDENTITIES='Name <mail>|Name2 <mail2>' extra author identities to accept (upstream history is allowed by default)
import { spawnSync } from 'node:child_process'
import { parts } from './private-patterns.mjs'

const RE = new RegExp(parts.join('|'), 'i')
const SECRET_FILE = /(^|\/)(\.env|.*\.pem|.*\.key|id_rsa|\.credentials.*|auth\.json)$/
const treeOnly = process.argv.includes('--tree')

const git = (args) => {
  const r = spawnSync('git', args, { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 })
  if (r.status !== 0 && r.status !== 1) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`)
  return r.stdout
}

let bad = 0
const report = (msg) => { bad++; process.stderr.write(`!! ${msg}\n`) }

const files = git(['ls-files', '-z']).split('\0').filter(Boolean)
for (const f of files) if (SECRET_FILE.test(f)) report(`secret-like file tracked: ${f}`)

const grep = git(['grep', '-I', '-n', '-i', '-E', RE.source, '--', '.', ':!pnpm-lock.yaml']).split('\n').filter(Boolean)
for (const line of grep.slice(0, 20)) report(`private string in tree: ${line.slice(0, 160)}`)

if (!treeOnly) {
  const msgs = git(['log', '--format=%H%x00%an <%ae>%x00%cn <%ce>%x00%B%x01'])
  for (const entry of msgs.split('\x01')) {
    const [sha, author, committer, ...rest] = entry.trim().split('\0')
    if (!sha) continue
    const hit = [author, committer, rest.join('\0')].join('\n').match(RE)
    if (hit) report(`private string "${hit[0]}" in commit ${sha.slice(0, 10)} (author, committer or message)`)
  }
}

if (bad > 0) { process.stderr.write(`private-strings check failed (${bad} problem${bad === 1 ? '' : 's'})\n`); process.exit(1) }
process.stdout.write(`private-strings check passed (${files.length} files${treeOnly ? '' : ', full history'})\n`)
