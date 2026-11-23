/**
 * Host half. Watches Omarchy's state directory and serves the resolved palette to the page: a GET snapshot plus a Remote stream.
 * Everything is registered with `ctx.effect`, so disabling the plugin closes the watcher and the routes.
 * The routes are read-only and call `connection.requestRejection` (fail closed when it is unavailable).
 */
import type { Context } from '@deepseek-ai/cordis'
import { OmarchyState } from './host/omarchy-state.ts'
import { LOOK_ROUTE, OMARCHY_ROUTE, serveLook, serveSnapshot, withAdmission } from './host/routes.ts'
import { registerThemeRemote } from './host/push.ts'
import type { Admission } from './host/routes.ts'
import { glassDefaultOf } from './shared/glass.ts'
import type { GlassDefault } from './shared/glass.ts'

export const name = '@t3labs/ohmydsh-theme'

/**
 * Profile config (dsh-theme row): `look: endfield` turns the Endfield look on for every device by default;
 * `glass: auto | off | subtle | standard | strong` sets how see-through the composer, sidebar and right panel are
 * (default auto: standard with the Endfield look, off otherwise). A browser can override both in Settings > Theme.
 */
export interface Config { look?: 'stock' | 'endfield'; glass?: GlassDefault }

export function apply(ctx: Context, config: Config = {}): void {
  const look = config?.look === 'endfield' ? 'endfield' : 'stock'
  const glass = glassDefaultOf(config?.glass)
  const state = new OmarchyState()
  let admission: Admission | undefined

  ctx.effect(() => {
    let stop: (() => void) | undefined
    let disposed = false
    void state.start().then((dispose) => {
      if (disposed) dispose()
      else stop = dispose
    }).catch((error: unknown) => { ctx.logger.warn(`dsh-theme: cannot watch Omarchy state: ${String(error)}`) })
    return () => { disposed = true; stop?.(); state.stop() }
  }, 'dsh-theme: Omarchy watcher')

  // Live palette over DSH's multiplexed Remote WebSocket (the gateway discovers the service by its binding).
  ctx.effect(() => registerThemeRemote(ctx as never, state), 'dsh-theme: remote stream')

  ctx.inject(['connection'], (c: Context) => {
    const check: Admission = (request) => {
      const r = (c as unknown as { connection: { requestRejection(r: unknown): number | undefined } }).connection.requestRejection(request)
      return r
    }
    admission = check
    return () => { if (admission === check) admission = undefined }
  })

  ctx.inject(['webServer'], (web: Context) => {
    const server = (web as unknown as { webServer: { register(route: { kind: 'exact'; path: string; handler: (req: never, res: never) => void }): () => void } }).webServer
    const guard = (handler: Parameters<typeof withAdmission>[1]) => withAdmission(() => admission, handler) as (req: never, res: never) => void
    web.effect(() => server.register({ kind: 'exact', path: OMARCHY_ROUTE, handler: guard(serveSnapshot(state)) }), 'dsh-theme: snapshot route')
    web.effect(() => server.register({ kind: 'exact', path: LOOK_ROUTE, handler: guard(serveLook(() => ({ look, glass }))) }), 'dsh-theme: look route')
  })
}
