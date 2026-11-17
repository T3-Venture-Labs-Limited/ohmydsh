// Copies what the app carries at runtime into apps/desktop/bundle/ohmydsh: the manifest, the profile defaults and the omd CLI.
// The plugins themselves are NOT bundled: the first launch installs them (pinned versions from the manifest).
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..', '..', '..')
const out = join(here, '..', 'bundle', 'ohmydsh')
rmSync(out, { recursive: true, force: true })
mkdirSync(join(out, 'packages', 'cli'), { recursive: true })
for (const file of ['ohmydsh.json']) cpSync(join(root, file), join(out, file))
if (existsSync(join(root, 'profile'))) cpSync(join(root, 'profile'), join(out, 'profile'), { recursive: true })
for (const part of ['bin', 'src', 'package.json']) cpSync(join(root, 'packages', 'cli', part), join(out, 'packages', 'cli', part), { recursive: true })
console.log(`bundled ${out}`)
