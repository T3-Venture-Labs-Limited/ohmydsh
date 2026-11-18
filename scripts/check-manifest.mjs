#!/usr/bin/env node
// Consistency of ohmydsh.json with the repo, strict enough to release from:
//  - the manifest is valid with exact pins;
//  - every plugin we ship (sources) is a workspace package of that exact name, and its version EQUALS its pin
//    (the pin is what npm will serve, so a workspace version that differs would publish something nobody installs);
//  - the CLI (@t3labs/ohmydsh) is at the manifest version (the ohmydsh release number);
//  - every public workspace package is either the CLI or pinned in the manifest (nothing gets published unlisted);
//  - no published package depends on a private workspace package at runtime;
//  - rows files exist.
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseManifest } from '../packages/cli/src/manifest.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const manifest = parseManifest(readFileSync(join(root, 'ohmydsh.json'), 'utf8'))
const errs = []
const names = new Map([...Object.entries(manifest.plugins.core), ...Object.values(manifest.plugins.packs).flatMap((p) => Object.entries(p))])

const workspace = new Map()
for (const dir of readdirSync(join(root, 'packages'))) {
  const f = join(root, 'packages', dir, 'package.json')
  if (existsSync(f)) workspace.set(dir, JSON.parse(readFileSync(f, 'utf8')))
}

for (const [name, src] of Object.entries(manifest.sources)) {
  const pkgFile = join(root, src.workspace, 'package.json')
  if (!existsSync(pkgFile)) { errs.push(`${name}: ${src.workspace}/package.json does not exist`); continue }
  const pkg = JSON.parse(readFileSync(pkgFile, 'utf8'))
  if (pkg.name !== name) errs.push(`${name}: ${src.workspace} is named ${pkg.name}`)
  if (pkg.private === true) errs.push(`${name}: ${src.workspace} is private, it cannot be installed from npm`)
  const pinned = names.get(name)
  if (pkg.version !== pinned) errs.push(`${name}: manifest pins ${pinned}, workspace package is ${pkg.version} (they must be equal: bump both together)`)
}

const cli = workspace.get('cli')
if (cli === undefined) errs.push('packages/cli is missing')
else if (cli.version !== manifest.version) errs.push(`${cli.name} is ${cli.version} but ohmydsh.json is version ${manifest.version} (the CLI carries the release number)`)

for (const [dir, pkg] of workspace) {
  if (pkg.private === true || dir === 'cli') continue
  if (!pkg.name.startsWith('@t3labs/')) errs.push(`packages/${dir}: public package ${pkg.name} is outside the @t3labs scope`)
  if (!names.has(pkg.name)) errs.push(`packages/${dir}: public package ${pkg.name} is not pinned in ohmydsh.json (it would be published but never installed)`)
  if (pkg.publishConfig?.access !== 'public') errs.push(`packages/${dir}: publishConfig.access must be "public"`)
}
const privateNames = new Set([...workspace.values()].filter((p) => p.private === true).map((p) => p.name))
for (const [dir, pkg] of workspace) {
  if (pkg.private === true) continue
  for (const field of ['dependencies', 'peerDependencies', 'optionalDependencies']) for (const dep of Object.keys(pkg[field] ?? {})) if (privateNames.has(dep)) errs.push(`packages/${dir}: ${field} lists the private package ${dep}`)
}

for (const f of [manifest.profile.defaults, ...Object.values(manifest.packInfo).map((i) => i.rows)].filter(Boolean)) if (!existsSync(join(root, f))) errs.push(`missing file ${f}`)
if (errs.length > 0) { process.stderr.write(`manifest check failed:\n  - ${errs.join('\n  - ')}\n`); process.exit(1) }
process.stdout.write(`manifest ok: ohmydsh ${manifest.version}, dsh ${manifest.dsh}, ${names.size} plugins, ${Object.keys(manifest.plugins.packs).length} packs, ${[...workspace.values()].filter((p) => p.private !== true).length} public packages\n`)
