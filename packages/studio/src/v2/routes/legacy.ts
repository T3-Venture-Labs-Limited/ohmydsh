/** Legacy (dsh-image-gen) migration routes: batch import of gallery records, vault orphans, and a status probe. */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { StudioCore } from '../core.js'
import { importLegacy, importVaultOrphans, legacyStatus, MAX_BATCH, type LegacyDeps } from '../legacy-import.js'
import { HttpError, fail, json, readJson, sameOrigin } from './http.js'
import { replyError } from './jobs.js'

export async function serveLegacyApi(core: StudioCore, deps: LegacyDeps | undefined, req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
  const method = req.method ?? 'GET'
  if (method !== 'GET' && !sameOrigin(req)) return fail(res, 403, 'origin-rejected')
  try {
    if (deps === undefined) return fail(res, 503, 'legacy-import-unavailable')
    if (path === '/import-legacy/status' && method === 'GET') return json(res, 200, await legacyStatus(core, deps))
    if (method !== 'POST') return fail(res, method === 'GET' ? 404 : 405, method === 'GET' ? 'not-found' : 'method-not-allowed')
    if (path === '/import-legacy') {
      // Gallery records are small JSON (the bytes are read host-side), so 2 MB is generous for MAX_BATCH items.
      const body = (await readJson(req, 2 * 1024 * 1024)) as { items?: unknown; prompts?: unknown }
      if (Array.isArray(body.items) && body.items.length > MAX_BATCH) throw new HttpError(413, 'batch-too-large', `Send at most ${String(MAX_BATCH)} items per request`)
      return json(res, 200, await importLegacy(core, deps, body))
    }
    if (path === '/import-legacy/vault') {
      const body = (await readJson(req, 4 * 1024).catch(() => ({}))) as { limit?: unknown }
      return json(res, 200, await importVaultOrphans(core, deps, typeof body.limit === 'number' ? body.limit : 50))
    }
    return fail(res, 404, 'not-found')
  } catch (error) { return replyError(res, error) }
}
