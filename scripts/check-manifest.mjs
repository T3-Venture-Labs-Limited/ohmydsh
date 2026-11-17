#!/usr/bin/env node
// Consistency of ohmydsh.json with the repo: valid, exact pins, our packages match packages/*, rows files exist.
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseManifest } from '../packages/cli/src/manifest.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const manifest = parseManifest(readFileSync(join(root, 'ohmydsh.json'), 'utf8'))
const errs = []
const names = new Map([...Object.entries(manifest.plugins.core), ...Object.values(manifest.plugins.packs).flatMap((p) => Object.entries(p))])
for (const [name, src] of Object.entries(manifest.sources)) {
  const pkgFile = join(root, src.workspace, 'package.json')
  if (!existsSync(pkgFile)) { errs.push(`${name}: ${src.workspace}/package.json does not exist`); continue }
  const pkg = JSON.parse(readFileSync(pkgFile, 'utf8'))
  if (pkg.name !== name) errs.push(`${name}: ${src.workspace} is named ${pkg.name}`)
  if (pkg.version !== names.get(name)) errs.push(`${name}: manifest pins ${names.get(name)}, workspace package is ${pkg.version}`)
}
for (const f of [manifest.profile.defaults, ...Object.values(manifest.packInfo).map((i) => i.rows)].filter(Boolean)) if (!existsSync(join(root, f))) errs.push(`missing file ${f}`)
if (errs.length > 0) { process.stderr.write(`manifest check failed:\n  - ${errs.join('\n  - ')}\n`); process.exit(1) }
process.stdout.write(`manifest ok: ohmydsh ${manifest.version}, dsh ${manifest.dsh}, ${names.size} plugins, ${Object.keys(manifest.plugins.packs).length} packs\n`)
