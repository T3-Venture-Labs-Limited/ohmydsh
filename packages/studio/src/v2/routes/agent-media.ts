/** Agent media routes: run the backfill by hand and read its last summary. Mutations are same-origin only. */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { StudioCore } from '../core.js'
import { readBackfillMarker, type BackfillSummary } from '../agent-backfill.js'
import { fail, json, sameOrigin } from './http.js'
import { replyError } from './jobs.js'

export interface AgentMediaApi {
  /** Run the backfill now (single flight: a second call while one runs joins it). */
  backfill(): Promise<BackfillSummary>
  /** Current title of a chat, when the host can read it. */
  sessionTitle(id: string): Promise<string | undefined>
  running(): boolean
}

export async function serveAgentMediaApi(core: StudioCore, agent: AgentMediaApi | undefined, req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
  const method = req.method ?? 'GET'
  if (method !== 'GET' && !sameOrigin(req)) return fail(res, 403, 'origin-rejected')
  try {
    if (agent === undefined) return fail(res, 503, 'agent-media-unavailable')
    if (path === '/agent-media/status' && method === 'GET') return json(res, 200, { running: agent.running(), last: readBackfillMarker(core)?.summary ?? null, count: core.db.queryAssets({ source: 'agent', limit: 1 }).total })
    if (path === '/agent-media/backfill' && method === 'POST') return json(res, 200, { summary: await agent.backfill() })
    return fail(res, 404, 'not-found')
  } catch (error) { return replyError(res, error) }
}
