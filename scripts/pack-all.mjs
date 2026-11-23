#!/usr/bin/env node
// Pack every public workspace package into <out>/ (default .tmp/tarballs) exactly as `pnpm publish` would, audit each
// tarball (private strings, absolute paths in source maps, required files) and write <out>/ohmydsh.json: a copy of the
// root manifest whose sources point at the packed files. `omd setup --manifest <out>/ohmydsh.json` then installs the
// whole set from tarballs: the registry shape, without a registry.
//
//   node scripts/pack-all.mjs [--out DIR] [--list]
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parts } from './private-patterns.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const out = resolve(args.includes('--out') ? args[args.indexOf('--out') + 1] : join(root, '.tmp', 'tarballs'))
const RE = new RegExp([...parts, '/home/(?!me/|user/|runner/)[a-z][a-z0-9_-]*/', '/Users/[A-Za-z]', 'C:\\\\Users\\\\'].join('|'), 'i')
const manifest = JSON.parse(readFileSync(join(root, 'ohmydsh.json'), 'utf8'))
const problems = []

rmSync(out, { recursive: true, force: true })
mkdirSync(out, { recursive: true })
const sh = (cmd, a, o = {}) => spawnSync(cmd, a, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, ...o })

const rows = []
for (const dir of readdirSync(join(root, 'packages')).sort()) {
  const pkgDir = join(root, 'packages', dir)
  const pj = join(pkgDir, 'package.json')
  if (!existsSync(pj)) continue
  const pkg = JSON.parse(readFileSync(pj, 'utf8'))
  if (pkg.private === true) { console.log(`skip   ${pkg.name} (private)`); continue }
  const r = sh('pnpm', ['pack', '--pack-destination', out, '--json'], { cwd: pkgDir })
  if (r.status !== 0) { problems.push(`${pkg.name}: pnpm pack failed: ${r.stderr.trim().split('\n').slice(-5).join(' | ')}`); continue }
  const receipt = JSON.parse(r.stdout.slice(r.stdout.indexOf('{')))
  const file = receipt.filename.startsWith('/') ? receipt.filename : join(out, receipt.filename)
  rows.push({ dir, pkg, file, files: receipt.files.map((f) => f.path) })
}

// Audit: unpack and scan.
const scratch = join(out, '.unpacked')
for (const row of rows) {
  const dest = join(scratch, row.dir)
  mkdirSync(dest, { recursive: true })
  const x = sh('tar', ['-xzf', row.file, '-C', dest])
  if (x.status !== 0) { problems.push(`${row.pkg.name}: cannot unpack ${row.file}`); continue }
  const base = join(dest, 'package')
  const need = ['package.json', 'README.md']
  // The Parallel fork keeps its upstream layout: no icon or locale (it contributes a provider, not UI). GenUI keeps its
  // upstream layout too: icon under assets/, i18n compiled into the bundle, and src/ published on purpose (its `./embed`
  // and `./assets/*` exports point at TypeScript sources for hosts that bundle the renderer themselves).
  if (row.dir !== 'cli') need.push('cordis.patch.yml', 'LICENSE')
  if (!['cli', 'web-search-parallel', 'genui'].includes(row.dir)) need.push('icon.svg', 'locale/en.json')
  if (row.dir === 'genui') need.push('assets/genui-icon.svg', 'NOTICE', 'UPSTREAM.md')
  for (const n of need) if (!existsSync(join(base, n))) problems.push(`${row.pkg.name}: tarball lacks ${n}`)
  if (!['cli', 'browser-takeover'].includes(row.dir) && !existsSync(join(base, 'lib'))) problems.push(`${row.pkg.name}: tarball lacks lib/`)
  if (existsSync(join(base, 'NOTICE')) === false && row.dir !== 'cli' && row.dir !== 'browser-takeover') problems.push(`${row.pkg.name}: tarball lacks NOTICE`)
  for (const f of row.files) {
    if (/(^|\/)(tests?|src|\.tmp|node_modules|\.env[^/]*)(\/|$)/.test(f) && !/^src\//.test(f) || /\.(pem|key)$/.test(f)) problems.push(`${row.pkg.name}: tarball contains ${f}`)
    if (/^src\//.test(f) && !['cli', 'genui'].includes(row.dir)) problems.push(`${row.pkg.name}: tarball contains source ${f}`)
    if (/^package\/(tests|scripts|tools)\//.test(`package/${f}`)) problems.push(`${row.pkg.name}: tarball contains ${f}`)
    const abs = join(base, f)
    if (!existsSync(abs) || /\.(png|jpe?g|webp|gif|ico|woff2?|ttf|whl|node|zip|gz)$/i.test(f)) continue
    const text = readFileSync(abs, 'utf8')
    const m = RE.exec(text)
    if (m) problems.push(`${row.pkg.name}: ${f} contains the forbidden string "${m[0]}" near "${text.slice(Math.max(0, m.index - 40), m.index + 60).replace(/\s+/g, ' ')}"`)
    if (f.endsWith('.map')) {
      try {
        const map = JSON.parse(text)
        for (const s of map.sources ?? []) if (/^(\/|[A-Za-z]:\\)/.test(s)) problems.push(`${row.pkg.name}: ${f} lists the absolute source path ${s}`)
      } catch { problems.push(`${row.pkg.name}: ${f} is not valid JSON`) }
    }
  }
}
rmSync(scratch, { recursive: true, force: true })

// Manifest pointing at the packed files (relative paths, resolved next to the manifest).
const local = structuredClone(manifest)
for (const row of rows) {
  if (row.dir === 'cli') continue
  if (local.sources[row.pkg.name] === undefined) { problems.push(`${row.pkg.name}: public package missing from manifest sources`); continue }
  local.sources[row.pkg.name] = { workspace: local.sources[row.pkg.name].workspace, tarball: `./${row.file.split('/').pop()}` }
}
local.profile.defaults = join(root, manifest.profile.defaults)
for (const info of Object.values(local.packInfo)) if (info.rows) info.rows = join(root, info.rows)
for (const [key, v] of Object.entries(local.patches ?? {})) {
  const p = typeof v === 'string' ? { file: v } : v
  local.patches[key] = { ...p, file: join(root, p.file) }
}
writeFileSync(join(out, 'ohmydsh.json'), `${JSON.stringify(local, null, 2)}\n`)

console.log('')
for (const row of rows) {
  const size = readFileSync(row.file).length
  console.log(`${`${row.pkg.name}@${row.pkg.version}`.padEnd(48)} ${String(row.files.length).padStart(4)} files ${(size / 1024).toFixed(0).padStart(7)} KiB  ${row.file.split('/').pop()}`)
  if (args.includes('--list')) for (const f of row.files) console.log(`    ${f}`)
}
if (problems.length > 0) { console.error(`\npack audit failed:\n  - ${problems.join('\n  - ')}`); process.exit(1) }
console.log(`\npack audit passed: ${rows.length} tarballs in ${out}`)
