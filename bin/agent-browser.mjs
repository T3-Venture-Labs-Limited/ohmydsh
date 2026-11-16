#!/usr/bin/env node
/**
 * Wrapper set as dsh-agent-browser's `binaryPath` by this bundle's patch.
 *
 * It runs the agent-browser binary that dsh-agent-browser installed and gives
 * every browser session its OWN persistent Chrome profile, so conversations in
 * different projects can browse in parallel (Chrome locks a profile to one
 * running browser). Each new profile starts from the shared login store
 * (`logins.json`), which the takeover plugin fills when you hand a browser
 * back after signing in, or when an agent calls browser_save_logins.
 *
 * Layout under ABX_ROOT (default ~/.agent-browser/dsh):
 *   logins.json                    shared logins (agent-browser state format, 0600)
 *   sessions/<session>/chrome/     Chrome profile of one browser session
 *   sessions/<session>/.seeded     when shared logins were last loaded into it
 *   sessions/<session>/.last-used  touched on every call (for pruning)
 *
 * Only DSH's agent-browser spawns see this; your shell, pi, and other tools
 * keep their own agent-browser state. dsh-agent-browser-core runs a `.mjs`
 * binaryPath through process.execPath and strips DSH_* variables, so
 * overrides use an ABX_ prefix:
 *   ABX_ROOT          state root (default ~/.agent-browser/dsh)
 *   ABX_PROFILE       force one profile directory for every session ("off": throwaway)
 *   ABX_BINARY        explicit agent-browser binary path
 */
import { spawn, spawnSync } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, statSync, utimesSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

function nativeIn(pkgDir) {
  const plat = process.platform
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64'
  const native = path.join(pkgDir, 'bin', `agent-browser-${plat}-${arch}${plat === 'win32' ? '.exe' : ''}`)
  if (existsSync(native)) return native
  const launcher = path.join(pkgDir, 'bin', 'agent-browser.js')
  return existsSync(launcher) ? launcher : undefined
}

function ancestors(start) {
  const out = []
  let dir = start
  for (;;) {
    out.push(dir)
    const parent = path.dirname(dir)
    if (parent === dir) return out
    dir = parent
  }
}

function resolveBinary() {
  if (process.env.ABX_BINARY && existsSync(process.env.ABX_BINARY)) return process.env.ABX_BINARY
  // argv[1] keeps the symlinked profile path (…/profiles/<p>/node_modules/<this>/bin/…)
  // while import.meta.url is the realpath; try both so linked and copied installs work.
  const starts = [process.argv[1] ? path.dirname(path.resolve(process.argv[1])) : undefined, path.dirname(fileURLToPath(import.meta.url))]
  for (const start of starts.filter(Boolean)) {
    for (const dir of ancestors(start)) {
      const pkg = path.basename(dir) === 'node_modules' ? path.join(dir, 'agent-browser') : path.join(dir, 'node_modules', 'agent-browser')
      const found = existsSync(path.join(pkg, 'package.json')) ? nativeIn(pkg) : undefined
      if (found) return found
    }
  }
  // Last resort: any DSH profile that has dsh-agent-browser's agent-browser.
  const profiles = path.join(os.homedir(), '.dsh', 'profiles')
  try {
    const names = readdirSync(profiles).sort((a, b) => (a === 'web' ? -1 : b === 'web' ? 1 : a.localeCompare(b)))
    for (const name of names) {
      const found = nativeIn(path.join(profiles, name, 'node_modules', 'agent-browser'))
      if (found) return found
    }
  } catch { /* no profiles dir */ }
  return 'agent-browser'
}

const binary = resolveBinary()
const isScript = /\.[cm]?js$/.test(binary)
const env = { ...process.env }
const args = process.argv.slice(2)

const root = env.ABX_ROOT ?? path.join(os.homedir(), '.agent-browser', 'dsh')
const seedFile = path.join(root, 'logins.json')

/** `--session <name>` from the argv dsh-agent-browser-core assembles; "default" when absent. */
function sessionOf(argv) {
  const i = argv.indexOf('--session')
  return i >= 0 && typeof argv[i + 1] === 'string' ? argv[i + 1] : 'default'
}

/** The first command token after the global flags (core always puts --json last). */
function commandOf(argv) {
  const i = argv.indexOf('--json')
  return i >= 0 ? argv.slice(i + 1) : argv
}

/** Global flags before the command, reused for the seeding calls. */
function prefixOf(argv) {
  const i = argv.indexOf('--json')
  return i >= 0 ? argv.slice(0, i + 1) : ['--json']
}

function run(argv) {
  return spawnSync(isScript ? process.execPath : binary, isScript ? [binary, ...argv] : argv, {
    env, stdio: ['ignore', 'pipe', 'ignore'], timeout: 60_000, encoding: 'utf8',
  })
}

function touch(file) {
  const now = new Date()
  try { utimesSync(file, now, now) } catch { try { closeSync(openSync(file, 'a')) } catch { /* ignore */ } }
}

function mtime(file) {
  try { return statSync(file).mtimeMs } catch { return 0 }
}

/** Socket directory agent-browser uses for this env (to tell whether a session's browser runs). */
function socketDir() {
  if (env.AGENT_BROWSER_SOCKET_DIR) {
    return env.AGENT_BROWSER_NAMESPACE
      ? path.join(env.AGENT_BROWSER_SOCKET_DIR, 'namespaces', env.AGENT_BROWSER_NAMESPACE, 'run')
      : env.AGENT_BROWSER_SOCKET_DIR
  }
  const base = env.XDG_RUNTIME_DIR ? path.join(env.XDG_RUNTIME_DIR, 'agent-browser') : path.join(os.homedir(), '.agent-browser')
  return env.AGENT_BROWSER_NAMESPACE ? path.join(base, 'namespaces', env.AGENT_BROWSER_NAMESPACE, 'run') : base
}

function daemonRunning(session) {
  try {
    const pid = Number.parseInt(readFileSync(path.join(socketDir(), `${session}.pid`), 'utf8').trim(), 10)
    if (!Number.isInteger(pid) || pid <= 0) return false
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function sleep(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms) }

// Commands that never start a browser: no profile work, no seeding.
const NON_LAUNCHING = new Set(['stream', 'close', 'session', 'state', 'profiles', 'skills', 'plugin', 'doctor', '--version', '-V', 'help', '--help'])

const session = sessionOf(args)
const command = commandOf(args)
const launching = command.length > 0 && !NON_LAUNCHING.has(command[0])

if (env.ABX_PROFILE) {
  if (env.ABX_PROFILE !== 'off' && !env.AGENT_BROWSER_PROFILE) env.AGENT_BROWSER_PROFILE = env.ABX_PROFILE
} else if (!env.AGENT_BROWSER_PROFILE && /^[\p{L}\p{N}_-]{1,64}$/u.test(session)) {
  const dir = path.join(root, 'sessions', session)
  const profile = path.join(dir, 'chrome')
  // Only browser-starting commands create a profile; `close`/`stream` for a
  // session that never ran must not leave an empty directory behind.
  if (launching || existsSync(dir)) {
    try { mkdirSync(profile, { recursive: true, mode: 0o700 }) } catch { /* agent-browser reports it */ }
    env.AGENT_BROWSER_PROFILE = profile
    touch(path.join(dir, '.last-used'))
  }

  // Load the shared logins when this browser is about to start and they are
  // newer than what the profile last received (always true for a new profile).
  const marker = path.join(dir, '.seeded')
  const seedAt = mtime(seedFile)
  if (launching && seedAt > 0 && seedAt > mtime(marker) && !daemonRunning(session)) {
    const lock = path.join(dir, '.seed-lock')
    let owned = false
    try { mkdirSync(lock); owned = true } catch { /* another call is seeding */ }
    if (owned) {
      try {
        const prefix = prefixOf(args)
        const opened = run([...prefix, 'open', 'about:blank'])
        if (opened.status === 0) run([...prefix, 'state', 'load', seedFile])
        touch(marker)
      } finally {
        try { rmSync(lock, { recursive: true, force: true }) } catch { /* ignore */ }
      }
    } else {
      for (let waited = 0; waited < 30_000 && existsSync(lock); waited += 250) sleep(250)
    }
  }
}

const child = spawn(isScript ? process.execPath : binary, isScript ? [binary, ...args] : args, { stdio: 'inherit', env })
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => { try { child.kill(signal) } catch { /* gone */ } })
}
child.on('error', (error) => {
  process.stdout.write(JSON.stringify({ success: false, data: null, error: `agent-browser wrapper could not start ${binary}: ${error.message}` }))
  process.exit(127)
})
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal)
  else process.exit(code ?? 1)
})
