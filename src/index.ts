// Host half of dsh-review-comments: durable per-session comment storage, the `review_comments` agent tool, and the
// routes the browser uses to sync. The browser keeps its own copy (offline-first) and merges through /sync.
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { HostStore, SESSION_ID, TooLargeError } from './host/store.ts'
import { createReviewTool, TOOL } from './host/tool.ts'
import { registerReviewRemote } from './host/push.ts'

export const name = 'dsh-review-comments'
export const API = '/api/review-comments'

interface Peerish { headers: Headers }
type Json = Record<string, unknown>

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } })

/** Mutations must come from the page itself: an Origin header, when present, has to name this host. */
export function sameOrigin(headers: Headers): boolean {
  const origin = headers.get('origin')
  if (origin === null) return true
  const host = headers.get('host')
  try { return host !== null && new URL(origin).host === host } catch { return false }
}

export function apply(ctx: Context): void {
  const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  const store = new HostStore(join(dshHome, 'review-comments'))

  // Push channel: tells open pages that a session's comments changed on the Host (an agent resolved one), over DSH's
  // multiplexed Remote WebSocket instead of a per-plugin HTTP stream. No polling.
  ctx.effect(() => registerReviewRemote(ctx as never, store), 'review-comments: remote stream')

  // Agent tool: registered once; the call's agent id is the session id.
  ctx.inject(['tools'], (c: Context) => {
    const tools = (c as unknown as { tools: { register(t: unknown): () => void } }).tools
    c.effect(() => tools.register(createReviewTool(store)), `review-comments: ${TOOL}`)
  })

  ctx.inject(['connection'], (c: Context) => {
    const connection = (c as unknown as { connection: { fetch: { register(r: unknown): () => Promise<void> }; requestRejection(r: Peerish): number | undefined } }).connection
    const admit = (request: Request): Response | undefined => {
      let rejection: number | undefined
      try { rejection = connection.requestRejection(request) } catch { rejection = 503 }
      if (rejection !== undefined) return json(rejection, { error: rejection === 401 ? 'unauthorized' : 'forbidden' })
      if (!sameOrigin(request.headers)) return json(403, { error: 'origin-rejected' })
      return undefined
    }

    // Sync: POST { sessionId, snapshot? }. Merges the browser's snapshot (when given) and returns the merged one.
    c.effect(() => connection.fetch.register({
      path: `${API}/sync`, methods: ['POST'], requestBody: 'buffered',
      fetch: async (request: Request) => {
        const rejected = admit(request)
        if (rejected !== undefined) return rejected
        let body: Json = {}
        try { const parsed = await request.json() as unknown; if (typeof parsed === 'object' && parsed !== null) body = parsed as Json } catch { return json(400, { ok: false, error: 'bad-request' }) }
        const sessionId = typeof body.sessionId === 'string' ? body.sessionId : ''
        if (!SESSION_ID.test(sessionId)) return json(400, { ok: false, error: 'bad-session' })
        try {
          const snapshot = body.snapshot === undefined ? await store.get(sessionId) : await store.merge(sessionId, body.snapshot)
          return json(200, { ok: true, snapshot })
        } catch (error) {
          if (error instanceof TooLargeError) return json(413, { ok: false, error: 'too-large', limit: error.limit })
          ctx.logger.warn(`review-comments: sync failed: ${error instanceof Error ? error.message : String(error)}`)
          return json(500, { ok: false, error: 'internal' })
        }
      },
    }), 'review-comments: sync route')
  })
}
