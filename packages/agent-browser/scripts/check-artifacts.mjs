// Fail the build when a file the package declares is missing: a missing client bundle crash-loops DSH on startup.
import { existsSync, readFileSync } from 'node:fs'
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const need = ['lib/index.js', 'lib/client.js', 'cordis.patch.yml', 'icon.svg', 'locale/en.json', 'docs/DETAIL.md', 'NOTICE', 'LICENSE']
const missing = need.filter((file) => !existsSync(new URL(`../${file}`, import.meta.url)))
if (missing.length > 0) { console.error(`missing build artifacts: ${missing.join(', ')}`); process.exit(1) }
const walk = (v) => (typeof v === 'string' ? [v] : typeof v === 'object' && v !== null ? Object.values(v).flatMap(walk) : [])
for (const target of walk(pkg.exports)) {
  if (!target.includes('*') && !existsSync(new URL(`../${target}`, import.meta.url))) { console.error(`export ${target} is missing`); process.exit(1) }
}
const client = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
if (!client.includes('id: "@t3labs/ohmydsh-agent-browser"')) { console.error('lib/client.js does not register under the package name'); process.exit(1) }
console.log('artifacts ok')
