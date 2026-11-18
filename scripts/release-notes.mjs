#!/usr/bin/env node
// Prints the CHANGELOG.md section of one version (the text under "## <version>" up to the next "## "), for the
// GitHub Release body. Fails when the version has no section so a release is never published without notes.
//   node scripts/release-notes.mjs 0.1.0
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const version = process.argv[2]
if (!version) { process.stderr.write('usage: release-notes.mjs <version>\n'); process.exit(2) }
const text = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'CHANGELOG.md'), 'utf8')
const lines = text.split('\n')
const start = lines.findIndex((l) => new RegExp(`^##\\s+\\[?${version.replace(/\./g, '\\.')}\\]?(\\s|$)`).test(l))
if (start === -1) { process.stderr.write(`CHANGELOG.md has no "## ${version}" section\n`); process.exit(1) }
let end = lines.findIndex((l, i) => i > start && /^##\s/.test(l))
if (end === -1) end = lines.length
const body = lines.slice(start + 1, end).join('\n').trim()
if (body === '') { process.stderr.write(`the "## ${version}" section of CHANGELOG.md is empty\n`); process.exit(1) }
process.stdout.write(`${body}\n`)
