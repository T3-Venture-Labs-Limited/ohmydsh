// HTTP surface: GET /api/dsh-theme/omarchy (JSON snapshot). The live channel is a Typert stream (see ./push.ts), not HTTP.
// The route is read-only and sit behind the Host admission check (fail closed); nothing here mutates state.
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { OmarchySnapshot, OmarchyState } from './omarchy-state.ts'

export const OMARCHY_ROUTE = '/api/dsh-theme/omarchy'
/** The profile's default look (`look` in the dsh-theme row config): `{ "look": "stock" | "endfield" }`. */
export const LOOK_ROUTE = '/api/dsh-theme/look'

/** Returns an HTTP status when the request must be refused. */
export type Admission = (request: IncomingMessage) => number | undefined

export function withAdmission(admission: () => Admission | undefined, handler: (req: IncomingMessage, res: ServerResponse) => void) {
  return (req: IncomingMessage, res: ServerResponse): void => {
    let rejection: number | undefined
    try {
      const check = admission()
      rejection = check === undefined ? 503 : check(req)
    } catch { rejection = 503 }
    if (rejection !== undefined) {
      res.writeHead(rejection, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(JSON.stringify({ error: rejection === 401 ? 'unauthorized' : rejection === 403 ? 'forbidden' : 'unavailable' }))
      return
    }
    handler(req, res)
  }
}

function methodNotAllowed(res: ServerResponse): void {
  res.writeHead(405, { allow: 'GET, HEAD', 'content-type': 'application/json; charset=utf-8' })
  res.end('{"error":"method-not-allowed"}')
}

/** The wire object for one snapshot (also the item the live stream yields). */
export const wireOf = (s: OmarchySnapshot | undefined): { available: boolean } & Partial<OmarchySnapshot> => ({ available: s !== undefined, ...s })
const body = (s: OmarchySnapshot | undefined): string => JSON.stringify(wireOf(s))

export function serveLook(look: () => 'stock' | 'endfield') {
  return (req: IncomingMessage, res: ServerResponse): void => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return methodNotAllowed(res)
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(req.method === 'HEAD' ? undefined : JSON.stringify({ look: look() }))
  }
}

export function serveSnapshot(state: OmarchyState) {
  return (req: IncomingMessage, res: ServerResponse): void => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return methodNotAllowed(res)
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(req.method === 'HEAD' ? undefined : body(state.current()))
  }
}

