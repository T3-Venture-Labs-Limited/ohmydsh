// Fail the build when a file the manifest declares is missing: a missing client bundle crash-loops the shared dev harness.
import { existsSync, readFileSync } from 'node:fs'
const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const need = ['lib/index.js', 'lib/client.js', 'cordis.patch.yml', 'icon.svg', 'locale/en.json']
const missing = need.filter(file => !existsSync(new URL(`../${file}`, import.meta.url)))
if (missing.length > 0) { console.error(`missing build artifacts: ${missing.join(', ')}`); process.exit(1) }
for (const [key, value] of Object.entries(manifest.exports)) {
  if (typeof value === 'string' && !value.includes('*') && !existsSync(new URL(`../${value}`, import.meta.url))) { console.error(`export ${key} -> ${value} is missing`); process.exit(1) }
}
console.log('artifacts ok')
