/** HyperFrames hand-off routes: status, open (create project + start loopback preview), stop, import-renders. */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { HyperframesManager } from '../hyperframes/launcher.js'
import { HfError } from '../hyperframes/launcher.js'
import { HttpError, fail, json, readJson, sameOrigin } from './http.js'
import { replyError } from './jobs.js'

export async function serveHyperframesApi(hf: HyperframesManager, req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
  const method = req.method ?? 'GET'
  if (method !== 'GET' && !sameOrigin(req)) return fail(res, 403, 'origin-rejected')
  try {
    if (path === '/hyperframes/status' && method === 'GET') return json(res, 200, await hf.status())
    if (method !== 'POST') return fail(res, method === 'GET' ? 404 : 405, method === 'GET' ? 'not-found' : 'method-not-allowed')
    const body = (await readJson(req, 64 * 1024)) as { assetIds?: unknown; project?: unknown; slug?: unknown }
    if (path === '/hyperframes/open') {
      const assetIds = Array.isArray(body.assetIds) ? body.assetIds.filter((x): x is string => typeof x === 'string').slice(0, 50) : []
      if (body.assetIds !== undefined && !Array.isArray(body.assetIds)) throw new HttpError(400, 'invalid-request', 'assetIds must be a list')
      const controller = new AbortController(); res.on('close', () => { if (!res.writableEnded) controller.abort(new Error('client closed')) })
      return json(res, 200, await hf.open({ assetIds, ...(typeof body.project === 'string' ? { project: body.project } : {}) }, controller.signal))
    }
    const slug = typeof body.slug === 'string' ? body.slug : ''
    if (path === '/hyperframes/stop') return json(res, 200, { stopped: await hf.stop(slug) })
    if (path === '/hyperframes/import-renders') return json(res, 200, { assets: await hf.importRenders(slug) })
    return fail(res, 404, 'not-found')
  } catch (error) {
    if (error instanceof HfError) return fail(res, error.status, error.code, error.message)
    return replyError(res, error)
  }
}
