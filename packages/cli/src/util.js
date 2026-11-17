// Small shared helpers: logging, filesystem, process runner. No dependencies.
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

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

/** Default process runner. Injected in tests. Never throws; spawn failures come back as status null + error. */
export function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, {
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
  for (const dir of (env.PATH ?? '').split(':')) if (dir && existsSync(join(dir, cmd))) return join(dir, cmd)
  return null
}

export function isUrl(s) {
  return /^(https?|file):\/\//i.test(s)
}
