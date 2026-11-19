'use strict'
// First-run provisioning, entirely inside the app's data folder:
//   1. <runtime>/node_modules: the pinned DSH CLI (@deepseek-ai/dsh) and the matching pnpm executable, installed with the
//      npm that ships inside the app, run by the app's own Node (bundled on Linux, else Electron as Node). No system Node, npm or pnpm is needed.
//   2. The omd profile in DSH_HOME: `omd setup --no-dsh-install` (the CLI that ships inside the app) installs the plugin
//      set from the bundled ohmydsh.json.
// Every step reports progress; every failure carries the last lines of the tool's output.
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const { redact } = require('./token-url')
const { writeShims, childEnv } = require('./shims')

class ProvisionError extends Error {}

const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8'))

/** The versions this app installs, taken from the bundled manifest. */
function wantedVersions(paths, pnpmVersion) {
  const manifest = read(paths.manifest)
  if (typeof manifest.dsh !== 'string') throw new ProvisionError('the bundled ohmydsh.json has no dsh version')
  return { dsh: manifest.dsh, pnpm: pnpmVersion, manifestVersion: manifest.version }
}

function readState(paths) {
  try { return read(paths.stateFile) } catch { return {} }
}

/** What still has to be done: `runtime` (DSH + pnpm) and/or `profile` (omd setup). */
function needs(paths, wanted, state = readState(paths), exists = fs.existsSync) {
  const runtimeOk = state.dsh === wanted.dsh && state.pnpm === wanted.pnpm && exists(paths.dshBin) && exists(paths.pnpmExe)
  const profileOk = state.manifestVersion === wanted.manifestVersion && state.dsh === wanted.dsh && exists(path.join(paths.dshHome, 'profiles', 'omd'))
  return { runtime: !runtimeOk, profile: !profileOk }
}

function run(file, args, { env, cwd, onLine, log, timeoutMs = 30 * 60 * 1000 }) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { env, cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    const tail = []
    const feed = (chunk) => {
      for (const line of chunk.toString('utf8').split(/\r?\n/)) {
        if (line.trim() === '') continue
        const safe = redact(line)
        tail.push(safe); if (tail.length > 30) tail.shift()
        log?.(safe)
        onLine?.(safe)
      }
    }
    child.stdout.on('data', feed)
    child.stderr.on('data', feed)
    const timer = setTimeout(() => { child.kill(); reject(new ProvisionError(`${path.basename(args[0] ?? file)} timed out`)) }, timeoutMs)
    child.on('error', (e) => { clearTimeout(timer); reject(new ProvisionError(`could not start ${file}: ${e.message}`)) })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve()
      else reject(new ProvisionError(`${path.basename(args[0] ?? file)} exited with code ${code}\n${tail.slice(-12).join('\n')}`))
    })
  })
}

/** Unpack the bundled npm (a registry tarball: everything sits under package/) into <runtime>/npm, once per npm version. */
async function unpackNpm(paths, env, log) {
  const stamp = path.join(paths.npmDir, '.tarball-size')
  const size = String(fs.statSync(paths.npmTarball).size)
  try { if (fs.readFileSync(stamp, 'utf8') === size && fs.existsSync(paths.npmCli)) return } catch { /* not unpacked yet */ }
  fs.rmSync(paths.npmDir, { recursive: true, force: true })
  fs.mkdirSync(paths.npmDir, { recursive: true })
  // bsdtar (macOS, Windows 10+) and GNU tar (Linux) both read .tgz; --strip-components drops the leading package/.
  await run('tar', ['-xzf', paths.npmTarball, '-C', paths.npmDir, '--strip-components=1'], { env, log })
  fs.writeFileSync(stamp, size)
}

/**
 * @param {object} o
 * @param {ReturnType<import('./paths').resolvePaths>} o.paths
 * @param {string} o.electron           executable that runs DSH, npm and omd: a real Node, or Electron acting as Node
 * @param {boolean} [o.electronAsNode]  `electron` is Electron, so children get ELECTRON_RUN_AS_NODE=1 (default true)
 * @param {string} o.pnpmVersion        pnpm version to install (pinned in the app's package.json)
 * @param {(p: { step: string, detail?: string, fraction?: number }) => void} o.progress
 * @param {(line: string) => void} [o.log]
 */
async function provision({ paths, electron, electronAsNode = true, pnpmVersion, progress, log, platform = process.platform }) {
  const wanted = wantedVersions(paths, pnpmVersion)
  const todo = needs(paths, wanted)
  // Every start, not only on install: an AppImage mounts at a new random path each launch, so yesterday's shims
  // would point at a folder that no longer exists.
  writeShims({ bin: paths.bin, electron, dshBin: paths.dshBin, omdBin: paths.omdBin, platform, electronAsNode })
  if (!todo.runtime && !todo.profile) return { changed: false, wanted }
  fs.mkdirSync(paths.runtime, { recursive: true })
  fs.mkdirSync(paths.dshHome, { recursive: true })
  const env = childEnv({ bin: paths.bin, pnpmDir: path.dirname(paths.pnpmExe), dshHome: paths.dshHome, platform, electronAsNode })
  const state = readState(paths)

  if (todo.runtime) {
    await unpackNpm(paths, env, log)
    progress({ step: 'Installing DeepSeek Harness', detail: `version ${wanted.dsh}`, fraction: 0.05 })
    fs.writeFileSync(path.join(paths.runtime, 'package.json'), `${JSON.stringify({ name: 'ohmydsh-runtime', private: true, version: '0.0.0', dependencies: {} }, null, 2)}\n`)
    const pkgs = [`@deepseek-ai/dsh@${wanted.dsh}`, `pnpm@${wanted.pnpm}`]
    await run(electron, [paths.npmCli, 'install', ...pkgs, '--save-exact', '--no-audit', '--no-fund', '--loglevel=error', '--foreground-scripts'], {
      env: { ...env, npm_config_cache: path.join(paths.runtime, 'npm-cache') }, cwd: paths.runtime, log,
      onLine: (l) => progress({ step: 'Installing DeepSeek Harness', detail: l.slice(0, 120), fraction: 0.2 }),
    })
    if (!fs.existsSync(paths.dshBin)) throw new ProvisionError(`installed DSH but ${paths.dshBin} is missing`)
    if (!fs.existsSync(paths.pnpmExe)) throw new ProvisionError(`installed pnpm but ${paths.pnpmExe} is missing (is this platform supported?)`)
    state.dsh = wanted.dsh; state.pnpm = wanted.pnpm
    fs.writeFileSync(paths.stateFile, `${JSON.stringify(state, null, 2)}\n`)
  }

  if (todo.profile) {
    progress({ step: 'Installing the ohmydsh plugins', detail: 'this takes a few minutes the first time', fraction: 0.4 })
    let seen = 0
    // OHMYDSH_OMD_ARGS: extra `omd setup` flags for tests and release candidates (for example `--dev` to link a checkout).
    const extra = (process.env.OHMYDSH_OMD_ARGS ?? '').split(/\s+/).filter(Boolean)
    await run(electron, [paths.omdBin, 'setup', '--no-dsh-install', '--manifest', paths.manifest, ...extra], {
      env, cwd: paths.runtime, log,
      onLine: (l) => { seen += 1; progress({ step: 'Installing the ohmydsh plugins', detail: l.replace(/^\S+\s+/, '').slice(0, 120), fraction: Math.min(0.95, 0.4 + seen / 400) }) },
    })
    state.manifestVersion = wanted.manifestVersion
    fs.writeFileSync(paths.stateFile, `${JSON.stringify(state, null, 2)}\n`)
  }
  progress({ step: 'Ready', fraction: 1 })
  return { changed: true, wanted }
}

module.exports = { provision, needs, wantedVersions, unpackNpm, ProvisionError, run }
