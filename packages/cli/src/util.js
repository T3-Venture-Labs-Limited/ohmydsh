// Small shared helpers: logging, filesystem, process runner. No dependencies.
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'

const tty = process.stdout.isTTY && !process.env.NO_COLOR
const paint = (code) => (s) => (tty ? `\u001b[${code}m${s}\u001b[0m` : s)
export const c = { dim: paint(2), red: paint(31), green: paint(32), yellow: paint(33), bold: paint(1) }

/** @param {{ quiet?: boolean }} [opts] */
export function makeLog(opts = {}) {
  const out = (s) => { if (!opts.quiet) process.stdout.write(`${s}\n`) }
  return {
    step: (s) => out(`${c.bold('==')} ${s}`),
    info: (s) => out(`   ${s}`),
    ok: (s) => out(`${c.green('ok')}  ${s}`),
    warn: (s) => process.stderr.write(`${c.yellow('warn')} ${s}\n`),
    error: (s) => process.stderr.write(`${c.red('error')} ${s}\n`),
    raw: out,
  }
}

export class OmdError extends Error {}

export function dshHome(env = process.env) {
  return env.DSH_HOME && env.DSH_HOME.length > 0 ? env.DSH_HOME : join(homedir(), '.dsh')
}

/**
 * Options that let spawn run `dsh` and friends on Windows, where npm and mise install `.cmd` shims: Node's spawn without a
 * shell finds only .exe files and refuses a .cmd (EINVAL). Arguments omd passes are plain words; any with a space or
 * a shell character is quoted.
 */
export const isWin = () => process.platform === 'win32'
export function shellFor(cmd, args = []) {
  if (!isWin() || /\.(exe|com)$/i.test(cmd)) return { cmd, args, opts: {} }
  const quote = (a) => (/^[\w@%+=:,./\\-]+$/.test(a) ? a : `"${String(a).replace(/"/g, '""')}"`)
  return { cmd, args: args.map(quote), opts: { shell: true } }
}

/** Default process runner. Injected in tests. Never throws; spawn failures come back as status null + error. */
export function run(cmd, args, opts = {}) {
  const sh = shellFor(cmd, args)
  const r = spawnSync(sh.cmd, sh.args, {
    ...sh.opts,
    cwd: opts.cwd,
    env: opts.env ?? process.env,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    stdio: opts.inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'],
    timeout: opts.timeoutMs,
  })
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', error: r.error }
}

export function which(cmd, env = process.env) {
  const path = env.PATH ?? env.Path ?? ''
  const exts = isWin() ? ['', ...(env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)] : ['']
  for (const dir of path.split(delimiter)) for (const ext of exts) if (dir && existsSync(join(dir, cmd + ext))) return join(dir, cmd + ext)
  return null
}

export function isUrl(s) {
  return /^(https?|file):\/\//i.test(s)
}
