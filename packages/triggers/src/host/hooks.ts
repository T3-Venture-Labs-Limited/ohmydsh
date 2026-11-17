/**
 * Webhook ingress: a raw node handler mounted as a `prefix` route at HOOK_BASE on the DSH web server.
 * Order: method (405) → automation lookup (404, same answer for unknown/disabled/non-webhook) → raw body ≤ MAX_BODY_BYTES
 * (413) → auth on the raw bytes (401, `rejected` row, rate-limited log) → parse → engine.fire (202 / 429 / 200 duplicate).
 * The session work runs after the response.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { HOOK_BASE, MAX_BODY_BYTES, type Automation, type RunRow } from '../shared/types.ts'
import { verifyWebhook } from './auth.ts'
import type { TriggersEngine } from './engine.ts'
import { RejectLimiter, type TriggersStore } from './store.ts'
import { newId } from './util.ts'

export interface HookDeps {
  engine: TriggersEngine
  store: TriggersStore
  log: { info(m: string): void; warn(m: string): void }
  now?: () => number
  rejects?: RejectLimiter
}

class TooLarge extends Error {}

export function readRawBody(req: IncomingMessage, limit = MAX_BODY_BYTES): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length'] ?? NaN)
    if (Number.isFinite(declared) && declared > limit) { req.resume(); reject(new TooLarge()); return }
    const chunks: Buffer[] = []
    let size = 0
    let failed = false
    req.on('data', (chunk: Buffer) => {
      if (failed) return
      size += chunk.length
      if (size > limit) { failed = true; req.resume(); reject(new TooLarge()); return }
      chunks.push(chunk)
    })
    req.on('end', () => { if (!failed) resolve(Buffer.concat(chunks)) })
    req.on('error', (error) => { if (!failed) { failed = true; reject(error) } })
  })
}

function send(res: ServerResponse, status: number, body: Record<string, unknown>, extra: Record<string, string> = {}): void {
  if (res.headersSent) return
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...extra })
  res.end(JSON.stringify(body))
}

export function automationIdFromUrl(url: string | undefined): string | undefined {
  const path = new URL(url ?? '/', 'http://dsh.internal').pathname
  if (!path.startsWith(`${HOOK_BASE}/`)) return undefined
  const id = decodeURIComponent(path.slice(HOOK_BASE.length + 1)).replace(/\/+$/, '')
  return /^[A-Za-z0-9_-]{1,80}$/.test(id) ? id : undefined
}

export function createHookHandler(deps: HookDeps): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const rejects = deps.rejects ?? new RejectLimiter(10)
  const now = (): number => deps.now?.() ?? Date.now()
  return async (req, res) => {
    try {
      if ((req.method ?? 'GET') !== 'POST') { req.resume(); send(res, 405, { error: 'method-not-allowed' }, { allow: 'POST' }); return }
      const id = automationIdFromUrl(req.url)
      const automation: Automation | undefined = id === undefined ? undefined : deps.store.get(id)
      if (automation === undefined || automation.source.kind !== 'webhook' || !automation.enabled) { req.resume(); send(res, 404, { error: 'not-found' }); return }
      let body: Buffer
      try { body = await readRawBody(req) } catch (error) {
        if (error instanceof TooLarge) { send(res, 413, { error: 'payload-too-large', limit: MAX_BODY_BYTES }, { connection: 'close' }); return }
        send(res, 400, { error: 'bad-request' }); return
      }
      const remote = req.socket?.remoteAddress
      const auth = verifyWebhook({ auth: automation.source.auth, secret: deps.store.secrets[automation.id], headers: req.headers, body, remoteAddress: remote, now: now() })
      if (!auth.ok) {
        if (rejects.allow(now())) {
          const row: RunRow = {
            runId: newId('run'), automationId: automation.id, automationName: automation.name, at: now(), source: 'webhook',
            eventId: '', summary: `POST from ${remote ?? 'unknown'}`, bytes: body.length, status: 'rejected', reason: auth.reason,
          }
          await deps.store.log(row)
        }
        send(res, 401, { error: 'unauthorized' }); return
      }
      const outcome = await deps.engine.fire(automation, deps.engine.webhookEvent(body, req.headers, remote))
      const { row } = outcome
      if (row.status === 'pending') {
        send(res, 202, { accepted: true, runId: row.runId })
        void outcome.done.catch((error: unknown) => { deps.log.warn(`triggers: webhook delivery crashed: ${String(error)}`) })
        return
      }
      if (row.reason === 'duplicate') { send(res, 200, { accepted: false, duplicate: true, runId: row.runId }); return }
      if (row.reason === 'filtered') { send(res, 202, { accepted: false, filtered: true, runId: row.runId }); return }
      if (row.reason === 'paused') { send(res, 503, { accepted: false, reason: 'paused', runId: row.runId }, { 'retry-after': '600' }); return }
      if (row.reason === 'disabled') { send(res, 404, { error: 'not-found' }); return }
      send(res, 429, { accepted: false, reason: row.reason ?? 'rate-limited', runId: row.runId }, { 'retry-after': '60' })
    } catch (error) {
      deps.log.warn(`triggers: webhook handler failed: ${error instanceof Error ? error.message : String(error)}`)
      send(res, 500, { error: 'internal' })
    }
  }
}
