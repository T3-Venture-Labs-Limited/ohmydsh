// Copies what the app carries at runtime into apps/desktop/bundle/ohmydsh: the manifest, the profile defaults and the omd CLI.
// The plugins themselves are NOT bundled: the first launch installs them (pinned versions from the manifest).
// On Linux it also downloads the official Node.js binary (pinned in package.json `ohmydsh.node`, SHA256 checked against
// nodejs.org's SHASUMS256.txt) into bundle/node/bin/node: the app runs DSH on it instead of on Electron (see src/node-runtime.js).
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
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
// Node.js for Linux x64 (the only target that needs it: Electron-as-Node crashes sharp there; macOS and Windows keep Electron as Node).
// The tarball is cached under bundle/.node-cache (or OHMYDSH_NODE_CACHE) and its checksum is re-verified against nodejs.org on every fresh unpack.
const nodeVersion = pkg.ohmydsh.node
const nodeTarget = join(bundle, 'node')
const nodeStamp = join(bundle, 'node.version')
const wantNode = process.platform === 'linux' && process.arch === 'x64' && process.env.OHMYDSH_SKIP_NODE !== '1'
if (!wantNode) {
  rmSync(nodeTarget, { recursive: true, force: true }); rmSync(nodeStamp, { force: true })
  console.log('no Node bundled (not linux-x64): the app runs DSH on Electron as Node')
} else {
  if (!/^\d+\.\d+\.\d+$/.test(nodeVersion ?? '')) throw new Error('package.json ohmydsh.node must be an exact Node version such as 24.22.3')
  if (!existsSync(join(nodeTarget, 'bin', 'node')) || !existsSync(nodeStamp) || readFileSync(nodeStamp, 'utf8') !== nodeVersion) {
    const cache = process.env.OHMYDSH_NODE_CACHE ? process.env.OHMYDSH_NODE_CACHE : join(bundle, '.node-cache')
    mkdirSync(cache, { recursive: true })
    const name = `node-v${nodeVersion}-linux-x64.tar.xz`
    const base = `https://nodejs.org/dist/v${nodeVersion}`
    const get = async (url) => {
      const r = await fetch(url)
      if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`)
      return Buffer.from(await r.arrayBuffer())
    }
    const sums = (await get(`${base}/SHASUMS256.txt`)).toString('utf8')
    const line = sums.split('\n').find((l) => l.trim().endsWith(`  ${name}`))
    if (!line) throw new Error(`SHASUMS256.txt has no entry for ${name}`)
    const expected = line.trim().split(/\s+/)[0]
    const sha = (buf) => createHash('sha256').update(buf).digest('hex')
    const file = join(cache, name)
    let tar = existsSync(file) ? readFileSync(file) : undefined
    if (tar !== undefined && sha(tar) !== expected) { console.log(`cached ${name} fails its checksum; downloading again`); tar = undefined }
    if (tar === undefined) {
      tar = await get(`${base}/${name}`)
      if (sha(tar) !== expected) throw new Error(`${name}: SHA256 ${sha(tar)} does not match nodejs.org (${expected})`)
      writeFileSync(file, tar)
    }
    console.log(`Node ${nodeVersion} linux-x64: SHA256 ${expected} matches SHASUMS256.txt`)
    const work = join(bundle, '.node-unpack')
    rmSync(work, { recursive: true, force: true }); mkdirSync(work, { recursive: true })
    const top = `node-v${nodeVersion}-linux-x64`
    execFileSync('tar', ['-xJf', file, '-C', work, '--strip-components=1', `${top}/bin/node`, `${top}/LICENSE`], { stdio: 'inherit' })
    rmSync(nodeTarget, { recursive: true, force: true })
    mkdirSync(join(nodeTarget, 'bin'), { recursive: true })
    renameSync(join(work, 'bin', 'node'), join(nodeTarget, 'bin', 'node'))
    renameSync(join(work, 'LICENSE'), join(nodeTarget, 'LICENSE'))
    chmodSync(join(nodeTarget, 'bin', 'node'), 0o755)
    rmSync(work, { recursive: true, force: true })
    writeFileSync(nodeStamp, nodeVersion)
  }
  console.log(`bundled Node ${nodeVersion} at ${join(nodeTarget, 'bin', 'node')}`)
}
console.log(`bundled ${out} and npm ${npmVersion}`)
