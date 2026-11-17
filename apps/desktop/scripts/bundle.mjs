// Copies what the app carries at runtime into apps/desktop/bundle/ohmydsh: the manifest, the profile defaults and the omd CLI.
// The plugins themselves are NOT bundled: the first launch installs them (pinned versions from the manifest).
import { execFileSync } from 'node:child_process'
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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

// npm, as one tarball (electron-builder drops every folder named node_modules from extra resources, and npm carries its
// dependencies inside one). The first run unpacks it next to the runtime; a child process cannot read inside an asar, so it
// is a resource. `npm pack` on the registry tarball is the whole thing: no install step.
const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8'))
const npmVersion = pkg.ohmydsh.npm
const bundle = join(here, '..', 'bundle')
const target = join(bundle, 'npm.tgz')
const stamp = join(bundle, 'npm.version')
if (!existsSync(target) || !existsSync(stamp) || readFileSync(stamp, 'utf8') !== npmVersion) {
  const work = join(bundle, '.npm-pack')
  rmSync(work, { recursive: true, force: true }); mkdirSync(work, { recursive: true })
  const win = process.platform === 'win32'
  const packed = execFileSync(win ? 'npm.cmd' : 'npm', ['pack', `npm@${npmVersion}`, '--silent', '--pack-destination', work], { encoding: 'utf8', shell: win }).trim().split(/\r?\n/).pop()
  copyFileSync(join(work, packed), target)
  writeFileSync(stamp, npmVersion)
  rmSync(work, { recursive: true, force: true })
}
console.log(`bundled ${out} and npm ${npmVersion}`)
