#!/usr/bin/env node
// dsh-kit token linter (ohmydsh-genui copy: adds --tokens-only and --extra-tokens, see UPSTREAM.md).
//   node token-lint.mjs [dir|file ...] [--tokens <file>] [--extra-tokens <file>] [--tokens-only] [--json]
// Defaults to scanning `src` (strict) and `lib` (tokens only; compiled output may carry artwork colours) of the cwd.
//
// Fails (exit 1) on:
//   1. any `--dsw-*` custom property that is not listed in dsw-defined.txt (the names the installed theme defines);
//   2. a dynamic `--dsw-…${…}` name (cannot be verified);
//   3. literal colours (#hex, rgb()/rgba()/hsl()/hsla() with numeric args) outside artwork.
// Artwork is exempt:
//   - files under a path segment named `artwork`, or named `*.artwork.*`;
//   - lines between `artwork:start` and `artwork:end` markers (in a comment), or a line containing `artwork:ok`;
//   - `token-lint-disable-line` on the same line silences everything for that line.
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { dirname, join, resolve, relative, sep, extname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.css', '.html'])
const SKIP_DIRS = new Set(['node_modules', '.git', '.tmp', 'coverage', 'dist'])

const args = process.argv.slice(2)
let tokensFile = join(here, 'dsw-defined.txt')
let json = false
let tokensOnlyAll = false
let extraTokensFile
const targets = []
for (let i = 0; i < args.length; i++) {
  const arg = args[i]
  if (arg === '--tokens') tokensFile = resolve(args[++i] ?? '')
  else if (arg === '--json') json = true
  else if (arg === '--tokens-only') tokensOnlyAll = true
  else if (arg === '--extra-tokens') extraTokensFile = resolve(args[++i] ?? '')
  else if (arg === '-h' || arg === '--help') { console.log('usage: token-lint.mjs [dir|file ...] [--tokens file] [--json]'); process.exit(0) }
  else targets.push(arg)
}
if (!existsSync(tokensFile)) { console.error(`token-lint: token list not found: ${tokensFile}`); process.exit(2) }
const defined = new Set(readFileSync(tokensFile, 'utf8').split('\n').map((l) => l.trim()).filter((l) => l.startsWith('--')))
if (defined.size === 0) { console.error(`token-lint: token list is empty: ${tokensFile}`); process.exit(2) }
if (extraTokensFile !== undefined) {
  if (!existsSync(extraTokensFile)) { console.error(`token-lint: extra token list not found: ${extraTokensFile}`); process.exit(2) }
  for (const l of readFileSync(extraTokensFile, 'utf8').split('\n').map((l) => l.trim())) if (l.startsWith('--')) defined.add(l)
}

/** @type {{ path: string, tokensOnly: boolean }[]} */
const roots = []
if (targets.length === 0) {
  if (existsSync('src')) roots.push({ path: 'src', tokensOnly: false })
  if (existsSync('lib')) roots.push({ path: 'lib', tokensOnly: true })
  if (roots.length === 0) { console.error('token-lint: no src/ or lib/ here; pass a directory'); process.exit(2) }
} else {
  for (const t of targets) {
    if (!existsSync(t)) { console.error(`token-lint: no such path: ${t}`); process.exit(2) }
    roots.push({ path: t, tokensOnly: resolve(t).split(sep).pop() === 'lib' })
  }
}

function* walk(path) {
  const info = statSync(path)
  if (info.isFile()) { if (EXTENSIONS.has(extname(path))) yield path; return }
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    if (entry.isDirectory()) { if (!SKIP_DIRS.has(entry.name)) yield* walk(join(path, entry.name)) }
    else if (entry.isFile() && EXTENSIONS.has(extname(entry.name))) yield join(path, entry.name)
  }
}

/** Replace comment text with spaces (keeping newlines) so colours in prose are ignored but line numbers survive. */
function blankComments(text) {
  let out = ''
  let i = 0
  let quote = ''
  while (i < text.length) {
    const c = text[i]
    const n = text[i + 1]
    if (quote) {
      out += c
      if (c === '\\') { out += n ?? ''; i += 2; continue }
      if (c === quote || (c === '\n' && quote !== '`')) quote = ''
      i++
      continue
    }
    if (c === '"' || c === "'" || c === '`') { quote = c; out += c; i++; continue }
    if (c === '/' && n === '*') {
      const end = text.indexOf('*/', i + 2)
      const stop = end === -1 ? text.length : end + 2
      out += text.slice(i, stop).replace(/[^\n]/g, ' ')
      i = stop
      continue
    }
    if (c === '/' && n === '/' && (i === 0 || /[\s;,{}()]/.test(text[i - 1]))) {
      const end = text.indexOf('\n', i)
      const stop = end === -1 ? text.length : end
      out += ' '.repeat(stop - i)
      i = stop
      continue
    }
    out += c
    i++
  }
  return out
}

const TOKEN = /--dsw-[A-Za-z0-9_-]*(\$\{)?/g
const HEX = /(?<![\w&])#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{4}|[0-9a-fA-F]{3})(?![\w-])/g
const FUNC = /\b(?:rgba?|hsla?)\(\s*[\d.]+/g

const violations = []
let files = 0
for (const root of roots) {
  for (const file of walk(root.path)) {
    files++
    const rel = relative(process.cwd(), file) || file
    const raw = readFileSync(file, 'utf8')
    const rawLines = raw.split('\n')
    const lines = blankComments(raw).split('\n')
    const artworkFile = rel.split(sep).includes('artwork') || /\.artwork\./.test(file)
    let inArtwork = artworkFile
    for (let n = 0; n < lines.length; n++) {
      const rawLine = rawLines[n] ?? ''
      if (/artwork:start/.test(rawLine)) inArtwork = true
      if (!/token-lint-disable-line/.test(rawLine)) {
        const line = lines[n] ?? ''
        for (const m of line.matchAll(TOKEN)) {
          if (m[1]) violations.push({ file: rel, line: n + 1, kind: 'dynamic-token', text: m[0] + '…' })
          else if (!defined.has(m[0])) violations.push({ file: rel, line: n + 1, kind: 'unknown-token', text: m[0] })
        }
        if (!root.tokensOnly && !tokensOnlyAll && !inArtwork && !/artwork:ok/.test(rawLine)) {
          for (const m of line.matchAll(HEX)) violations.push({ file: rel, line: n + 1, kind: 'literal-colour', text: m[0] })
          for (const m of line.matchAll(FUNC)) violations.push({ file: rel, line: n + 1, kind: 'literal-colour', text: m[0] + '…)' })
        }
      }
      if (/artwork:end/.test(rawLine) && !artworkFile) inArtwork = false
    }
  }
}

if (json) {
  console.log(JSON.stringify({ files, violations }, null, 2))
} else if (violations.length === 0) {
  console.log(`token-lint: ok (${files} files, ${defined.size} known tokens)`)
} else {
  for (const v of violations) console.error(`${v.file}:${v.line}  ${v.kind}  ${v.text}`)
  console.error(`token-lint: ${violations.length} problem(s) in ${files} files. Allowed tokens: ${relative(process.cwd(), tokensFile)}. Artwork colours need an artwork/ path or artwork:start/end markers.`)
}
process.exit(violations.length === 0 ? 0 : 1)
