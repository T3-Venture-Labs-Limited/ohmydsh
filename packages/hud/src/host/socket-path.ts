import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

/** The profile home this process serves: `DSH_HOME` or `~/.dsh`. */
export function dshHome(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env['DSH_HOME']
  return resolve(raw !== undefined && raw !== '' ? raw : join(homedir(), '.dsh'))
}

/**
 * Socket name scoped to the DSH home, so instances with different DSH homes (for example ~/.dsh and ~/.dsh-dev) never clash.
 * The Qt app derives the same name (src/socketpath.cpp): first 8 hex chars of sha256(absolute DSH_HOME).
 */
export function defaultSocketPath(env: NodeJS.ProcessEnv = process.env): string {
  const runtime = env['XDG_RUNTIME_DIR'] !== undefined && env['XDG_RUNTIME_DIR'] !== '' ? env['XDG_RUNTIME_DIR'] : `/run/user/${String(process.getuid?.() ?? 1000)}`
  const hash = createHash('sha256').update(dshHome(env)).digest('hex').slice(0, 8)
  return join(runtime, `dsh-hud-${hash}.sock`)
}
