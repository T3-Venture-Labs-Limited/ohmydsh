// Fails unless every file the manifest declares exists. Run after `tsdown` (the build script does it).
// A missing dsh.client bundle makes the Host crash-loop at activation, so this gate guards `dsh plugin add ... link:`.
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))
const missing = []
const need = (rel, why) => { if (!existsSync(resolve(root, rel))) missing.push(`${rel}  (${why})`) }

function* targets(value) {
  if (typeof value === 'string') yield value
  else if (value && typeof value === 'object') for (const v of Object.values(value)) yield* targets(v)
}

for (const [key, value] of Object.entries(pkg.exports ?? {})) {
  for (const target of targets(value)) {
    if (target.includes('*')) {
      const dir = target.slice(0, target.indexOf('*')).replace(/\/$/, '') || '.'
      const ext = target.slice(target.lastIndexOf('*') + 1)
      const found = existsSync(resolve(root, dir)) && readdirSync(resolve(root, dir)).some((f) => f.endsWith(ext))
      if (!found) missing.push(`${target}  (exports["${key}"] matches no file)`)
    } else need(target, `exports["${key}"]`)
  }
}
if (pkg.main) need(pkg.main, 'main')
if (pkg.dsh?.bundle?.patch) need(pkg.dsh.bundle.patch, 'dsh.bundle.patch')
if (pkg.dsh?.client) {
  if (pkg.dsh.client.platform !== 'web') missing.push('dsh.client.platform must be "web"')
  if (!pkg.exports?.['./client']) missing.push('dsh.client needs an exports["./client"] entry')
  need('lib/client.js', 'dsh.client bundle')
}
// The module loader supports only self-contained chunks: no synchronous require("./client*.js") between outputs.
if (pkg.dsh?.client && existsSync(resolve(root, 'lib'))) {
  for (const file of readdirSync(resolve(root, 'lib'))) {
    if (!/^client(\..+)?\.js$/.test(file)) continue
    const text = readFileSync(resolve(root, 'lib', file), 'utf8')
    const bad = text.match(/\brequire\((["'`])\.\/client[^"'`]*\1\)/)
    if (bad) missing.push(`lib/${file} synchronously requires ${bad[0]} (chunks must be self-contained: import shared code from exactly one lazy chunk)`)
  }
}
try {
  const en = JSON.parse(readFileSync(resolve(root, 'locale/en.json'), 'utf8'))
  if (!en.meta?.title || !en.meta?.description) missing.push('locale/en.json needs meta.title and meta.description')
  if (en.meta?.detail) need(en.meta.detail, 'locale/en.json meta.detail')
} catch { missing.push('locale/en.json (unreadable)') }
const range = pkg.engines?.dsh
if (range !== '>=0.2.2-rc.1 <0.3.0-0') missing.push(`engines.dsh must be ">=0.2.2-rc.1 <0.3.0-0" (found ${range})`)
for (const name of Object.keys({ ...pkg.devDependencies, ...pkg.peerDependencies })) {
  if (!name.startsWith('@deepseek-ai/')) continue
  if (pkg.devDependencies?.[name] === undefined || pkg.peerDependencies?.[name] === undefined) missing.push(`${name} must be in both peerDependencies and devDependencies`)
}
if (missing.length > 0) {
  console.error('check-artifacts: FAILED. Do not link this plugin into a profile until these exist:\n  ' + missing.join('\n  '))
  process.exit(1)
}
console.log('check-artifacts: ok (every declared artifact exists)')
