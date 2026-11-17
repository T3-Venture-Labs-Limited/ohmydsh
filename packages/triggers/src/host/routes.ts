/**
 * Page routes `POST /api/triggers/<method>` (JSON in, envelope `{ok:true,value}` / `{ok:false,error:{code,message}}` out).
 * Every call re-checks `connection.requestRejection` (fail closed) and same-origin, exactly like dsh-composio.
 */
import type { TriggersEngine } from './engine.ts'
import { PinError } from './pin.ts'
import type { TriggersStore } from './store.ts'
import { errorText } from './util.ts'
import { ValidationError } from './validate.ts'

export const METHODS = ['state', 'save', 'delete', 'setEnabled', 'setPaused', 'rotateSecret', 'test', 'preview', 'runs', 'models', 'composioAccounts', 'composioTriggerTypes'] as const

type Json = Record<string, unknown>
export interface ConnectionLike { requestRejection(r: { headers: Headers }): number | undefined }

export const ok = (value: unknown): Response => Response.json({ ok: true, value }, { headers: { 'cache-control': 'no-store' } })
export const fail = (code: string, message: string, status = 200): Response => Response.json({ ok: false, error: { code, message } }, { status, headers: { 'cache-control': 'no-store' } })

export function sameOrigin(headers: Headers): boolean {
  const origin = headers.get('origin')
  if (origin === null) return true
  const host = headers.get('host')
  try { return host !== null && new URL(origin).host === host } catch { return false }
}

export interface RouteDeps { engine: TriggersEngine; store: TriggersStore; modelCatalog: () => Promise<unknown> }

const idOf = (body: Json): string => { const id = body['id']; if (typeof id !== 'string' || id === '') throw new ValidationError('id is required'); return id }

export function routeHandler(deps: RouteDeps): (method: string, body: Json) => Promise<Response> {
  const { engine: eng, store } = deps
  return async (method, body) => {
    if (!store.loaded) return fail('not-ready', 'Triggers storage is still loading; try again in a moment.')
    switch (method) {
      case 'state': return ok(eng.state())
      case 'save': return ok(await eng.save(body))
      case 'delete': await eng.remove(idOf(body)); return ok(eng.state())
      case 'setEnabled': await eng.setEnabled(idOf(body), body['enabled'] === true); return ok(eng.state())
      case 'setPaused': await eng.setPaused(body['paused'] === true); return ok(eng.state())
      case 'rotateSecret': return ok(await eng.rotateSecret(idOf(body)))
      case 'test': return ok(await eng.test(idOf(body), body['payload']))
      case 'preview': {
        const automation = body['draft'] !== undefined && body['draft'] !== null
          ? eng.draft({ ...(body['draft'] as Json), ...(typeof body['id'] === 'string' ? { id: body['id'] } : {}) })
          : store.get(idOf(body))
        if (automation === undefined) return fail('not-found', 'unknown automation id')
        return ok(await eng.preview(automation, body['payload']))
      }
      case 'runs': {
        const limit = typeof body['limit'] === 'number' ? Math.min(Math.max(Math.round(body['limit']), 1), 2000) : 200
        return ok(store.recentRuns(limit, typeof body['id'] === 'string' ? body['id'] : undefined))
      }
      case 'models': return ok(await deps.modelCatalog())
      case 'composioAccounts': return ok(await eng.composio.accounts())
      case 'composioTriggerTypes': {
        const toolkit = body['toolkit']
        if (typeof toolkit !== 'string' || toolkit === '') return fail('bad-request', 'toolkit is required')
        return ok(await eng.composio.triggerTypes(toolkit))
      }
      default: return fail('not-found', `Unknown method "${method}".`, 404)
    }
  }
}

/** The fetch wrapper for one method: admission, same-origin, JSON body, error mapping. */
export async function serveRoute(method: string, request: Request, deps: { connection: ConnectionLike; handle: (method: string, body: Json) => Promise<Response>; log: { warn(m: string): void } }): Promise<Response> {
  let rejection: number | undefined
  try { rejection = deps.connection.requestRejection(request) } catch { rejection = 503 }
  if (rejection !== undefined) return fail(rejection === 401 ? 'unauthorized' : 'forbidden', 'rejected', rejection)
  if (!sameOrigin(request.headers)) return fail('origin-rejected', 'cross-origin request rejected', 403)
  let body: Json = {}
  try { const parsed = await request.json() as unknown; if (typeof parsed === 'object' && parsed !== null) body = parsed as Json } catch { return fail('bad-request', 'Body is not JSON') }
  try { return await deps.handle(method, body) } catch (error) {
    if (error instanceof ValidationError) return fail('bad-request', error.message)
    if (error instanceof PinError) return fail('unsafe', error.message)
    deps.log.warn(`triggers: ${method} failed: ${errorText(error).slice(0, 200)}`)
    return fail('failed', errorText(error).slice(0, 300))
  }
}
