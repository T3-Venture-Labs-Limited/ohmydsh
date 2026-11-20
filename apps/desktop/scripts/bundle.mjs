// Copies what the app carries at runtime into apps/desktop/bundle/ohmydsh: the manifest, the profile defaults and the omd CLI.
// The plugins themselves are NOT bundled: the first launch installs them (pinned versions from the manifest).
// It also downloads the official Node.js binary for the platform being built (pinned in package.json `ohmydsh.node`,
// SHA256 checked against nodejs.org's SHASUMS256.txt): Linux x64, Windows x64, macOS arm64 + x64. Each target lands in
// bundle/node/<target>/ and electron-builder.yml ships bundle/node/${os}-${arch} as resources/node, so every build carries
// the binary of its own architecture. The app runs DSH on it instead of on Electron (see src/node-runtime.js).
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
// Node.js, one official binary per target (SHA256 checked). Layout inside bundle/node/<target>/ mirrors resources/node:
//   linux-x64, mac-arm64, mac-x64   bin/node + LICENSE
//   win-x64                         node.exe + LICENSE
// The archive is cached under bundle/.node-cache (or OHMYDSH_NODE_CACHE); its checksum is re-verified against nodejs.org on every fresh unpack.
// Which targets: the ones the host platform builds (linux: linux-x64; win32: win-x64; darwin: mac-arm64 and mac-x64);
// OHMYDSH_NODE_TARGETS=linux-x64,win-x64 overrides, OHMYDSH_SKIP_NODE=1 bundles none (the app then falls back to Electron as Node).
const nodeVersion = pkg.ohmydsh.node
const nodeRoot = join(bundle, 'node')
const nodeStamp = join(bundle, 'node.version')
const TARGETS = {
  'linux-x64': { archive: 'linux-x64.tar.xz', exe: ['bin', 'node'] },
  'mac-arm64': { archive: 'darwin-arm64.tar.gz', exe: ['bin', 'node'] },
  'mac-x64': { archive: 'darwin-x64.tar.gz', exe: ['bin', 'node'] },
  'win-x64': { archive: 'win-x64.zip', exe: ['node.exe'] },
}
const hostTargets = process.platform === 'linux' && process.arch === 'x64' ? ['linux-x64'] : process.platform === 'win32' ? ['win-x64'] : process.platform === 'darwin' ? ['mac-arm64', 'mac-x64'] : []
const wanted = process.env.OHMYDSH_SKIP_NODE === '1' ? [] : process.env.OHMYDSH_NODE_TARGETS ? process.env.OHMYDSH_NODE_TARGETS.split(',').map((t) => t.trim()).filter(Boolean) : hostTargets
for (const t of wanted) if (!(t in TARGETS)) throw new Error(`unknown Node target ${t}; known: ${Object.keys(TARGETS).join(', ')}`)
const stampWant = `${nodeVersion} ${wanted.join(',')}`
const exeOf = (target) => join(nodeRoot, target, ...TARGETS[target].exe)
if (wanted.length === 0) {
  rmSync(nodeRoot, { recursive: true, force: true }); rmSync(nodeStamp, { force: true })
  console.log('no Node bundled for this platform: the app runs DSH on Electron as Node')
} else {
  if (!/^\d+\.\d+\.\d+$/.test(nodeVersion ?? '')) throw new Error('package.json ohmydsh.node must be an exact Node version such as 24.22.3')
  if (!wanted.every((t) => existsSync(exeOf(t))) || !existsSync(nodeStamp) || readFileSync(nodeStamp, 'utf8') !== stampWant) {
    rmSync(nodeRoot, { recursive: true, force: true })
    const cache = process.env.OHMYDSH_NODE_CACHE ? process.env.OHMYDSH_NODE_CACHE : join(bundle, '.node-cache')
    mkdirSync(cache, { recursive: true })
    const base = `https://nodejs.org/dist/v${nodeVersion}`
    const get = async (url) => {
      const r = await fetch(url)
      if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`)
      return Buffer.from(await r.arrayBuffer())
    }
    const sums = (await get(`${base}/SHASUMS256.txt`)).toString('utf8')
    const sha = (buf) => createHash('sha256').update(buf).digest('hex')
    for (const target of wanted) {
      const name = `node-v${nodeVersion}-${TARGETS[target].archive}`
      const line = sums.split('\n').find((l) => l.trim().endsWith(`  ${name}`))
      if (!line) throw new Error(`SHASUMS256.txt has no entry for ${name}`)
      const expected = line.trim().split(/\s+/)[0]
      const file = join(cache, name)
      let archive = existsSync(file) ? readFileSync(file) : undefined
      if (archive !== undefined && sha(archive) !== expected) { console.log(`cached ${name} fails its checksum; downloading again`); archive = undefined }
      if (archive === undefined) {
        archive = await get(`${base}/${name}`)
        if (sha(archive) !== expected) throw new Error(`${name}: SHA256 ${sha(archive)} does not match nodejs.org (${expected})`)
        writeFileSync(file, archive)
      }
      console.log(`Node ${nodeVersion} ${target}: SHA256 ${expected} matches SHASUMS256.txt`)
      const work = join(bundle, '.node-unpack')
      rmSync(work, { recursive: true, force: true }); mkdirSync(work, { recursive: true })
      const top = `node-v${nodeVersion}-${TARGETS[target].archive.replace(/\.(tar\.xz|tar\.gz|zip)$/, '')}`
      const members = [`${top}/${TARGETS[target].exe.join('/')}`, `${top}/LICENSE`]
      if (TARGETS[target].archive.endsWith('.zip')) {
        // Windows 10+ ships bsdtar (System32\tar.exe), which reads zip; elsewhere use unzip. Git's GNU tar on a Windows PATH cannot (and chokes on C:\ paths).
        if (process.platform === 'win32') execFileSync(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe'), ['-xf', file, '-C', work, '--strip-components=1', ...members], { stdio: 'inherit' })
        else execFileSync('unzip', ['-q', '-j', file, ...members, '-d', work], { stdio: 'inherit' })
      } else {
        const flag = TARGETS[target].archive.endsWith('.xz') ? '-xJf' : '-xzf'
        execFileSync('tar', [flag, file, '-C', work, '--strip-components=1', ...members], { stdio: 'inherit' })
      }
      const dest = join(nodeRoot, target)
      mkdirSync(dirname(exeOf(target)), { recursive: true })
      const unpacked = TARGETS[target].exe.length === 2 ? join(work, 'bin', 'node') : join(work, 'node.exe')
      renameSync(unpacked, exeOf(target))
      renameSync(join(work, 'LICENSE'), join(dest, 'LICENSE'))
      if (TARGETS[target].exe.length === 2) chmodSync(exeOf(target), 0o755)
      rmSync(work, { recursive: true, force: true })
    }
    writeFileSync(nodeStamp, stampWant)
  }
  for (const t of wanted) console.log(`bundled Node ${nodeVersion} (${t}) at ${exeOf(t)}`)
}
console.log(`bundled ${out} and npm ${npmVersion}`)
