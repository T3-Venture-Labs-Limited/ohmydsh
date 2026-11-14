/** Non-secret Studio settings: pinned Replicate models, HyperFrames CLI path. Secrets never pass through here. */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { StudioCore } from '../core.js'
import { HttpError, fail, json, readJson, sameOrigin } from './http.js'
import { replyError } from './jobs.js'

const KEYS = { 'replicate.pinned': 600, 'hyperframes.cli': 300, 'hyperframes.npx': 1 } as const
type Key = keyof typeof KEYS

export async function serveSettingsApi(core: StudioCore, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const method = req.method ?? 'GET'
  if (method !== 'GET' && !sameOrigin(req)) return fail(res, 403, 'origin-rejected')
  try {
    if (method === 'GET') return json(res, 200, { settings: Object.fromEntries((Object.keys(KEYS) as Key[]).map(k => [k, core.db.getSetting(k) ?? ''])) })
    if (method !== 'PUT') return fail(res, 405, 'method-not-allowed')
    const body = (await readJson(req, 16 * 1024)) as Record<string, unknown>
    for (const [k, v] of Object.entries(body)) {
      if (!(k in KEYS)) throw new HttpError(400, 'unknown-setting', `Unknown setting "${k.slice(0, 40)}"`)
      if (typeof v !== 'string' || v.length > KEYS[k as Key]) throw new HttpError(400, 'invalid-setting', `${k} must be text of at most ${String(KEYS[k as Key])} characters`)
      if (k === 'hyperframes.npx' && v !== '0' && v !== '1' && v !== '') throw new HttpError(400, 'invalid-setting', 'hyperframes.npx must be 0 or 1')
      if (k === 'hyperframes.cli' && /[\0\n\r]/.test(v)) throw new HttpError(400, 'invalid-setting', 'hyperframes.cli must be a single path')
    }
    for (const [k, v] of Object.entries(body)) core.db.setSetting(k, v as string)
    return json(res, 200, { settings: Object.fromEntries((Object.keys(KEYS) as Key[]).map(k => [k, core.db.getSetting(k) ?? ''])) })
  } catch (error) { return replyError(res, error) }
}
