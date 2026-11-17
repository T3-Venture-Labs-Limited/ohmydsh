/**
 * Host half: serves the dsh-hud Qt app over a DSH_HOME-scoped Unix socket (see host/bridge.ts).
 * The browser half only teaches the web UI to open a session named in the URL fragment ("Open in web").
 */
import type { Context } from '@deepseek-ai/cordis'
import { readFileSync } from 'node:fs'
import { Config } from './host/config.ts'
import { Bridge } from './host/bridge.ts'
import { Harness } from './host/harness.ts'
import { defaultSocketPath, dshHome } from './host/socket-path.ts'

export const name = 'dsh-hud'
export { Config }
export const inject = ['sessionController']

const version = ((): string => {
  try { return (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version?: string }).version ?? '0' } catch { return '0' }
})()

export function apply(ctx: Context, config: Config): void {
  if (!config.enabled) return
  const log = ctx.logger('dsh-hud')
  const socket = config.socketPath !== '' ? config.socketPath : defaultSocketPath()
  const harness = new Harness(ctx, () => config)
  const bridge = new Bridge(harness, log, { home: dshHome(), socket, workspace: () => config.workspace, model: () => `${config.model}${config.effort === '' ? '' : `:${config.effort}`}` }, version)
  let disposed = false
  void bridge.listen(socket).then((ok) => { if (disposed && ok) bridge.close() })
  ctx.effect(() => () => { disposed = true; bridge.close() }, 'dsh-hud: socket')
  // Live list push: the HUD re-requests sessions/list when anything changes.
  let timer: ReturnType<typeof setTimeout> | undefined
  const changed = (): void => { clearTimeout(timer); timer = setTimeout(() => { bridge.sessionsChanged() }, 150) }
  ctx.effect(() => () => { clearTimeout(timer) }, 'dsh-hud: debounce')
  for (const event of ['api-session/added', 'api-session/removed', 'api-session/status', 'api-session/activity']) {
    ctx.effect(() => ctx.on(event as never, changed as never), `dsh-hud: ${event}`)
  }
}
