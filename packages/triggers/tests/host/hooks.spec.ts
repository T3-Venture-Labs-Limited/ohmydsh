// @vitest-environment node
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { signHubSha256, signStandardWebhook } from '../../src/host/auth.ts'
import { TriggersEngine } from '../../src/host/engine.ts'
import { automationIdFromUrl, createHookHandler } from '../../src/host/hooks.ts'
import { TriggersStore } from '../../src/host/store.ts'
import { HOOK_BASE, MAX_BODY_BYTES, type WebhookAuth } from '../../src/shared/types.ts'
import { log, tempDir, until } from './helpers.ts'

let dir: string; let cleanup: () => Promise<void>
let server: Server; let base: string
let store: TriggersStore; let engine: TriggersEngine
let deliver: ReturnType<typeof vi.fn<() => Promise<{ sessionId: string }>>>

beforeEach(async () => {
  ({ dir, cleanup } = await tempDir('triggers-hooks-'))
  store = new TriggersStore(join(dir, 'triggers')); await store.load()
  deliver = vi.fn<() => Promise<{ sessionId: string }>>(async () => ({ sessionId: 'session-x' }))
  engine = new TriggersEngine({ store, deliver, origin: () => base, hasAutomationModels: () => false, hasComposio: () => false, workspaces: () => [], defaultCwd: () => dir, log })
  const handler = createHookHandler({ engine, store, log })
  // Mounted like the web server's prefix route: only HOOK_BASE and HOOK_BASE/* reach the handler.
  server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname
    if (path === HOOK_BASE || path.startsWith(`${HOOK_BASE}/`)) void handler(req, res)
    else { res.writeHead(404); res.end() }
  })
  await new Promise<void>((r) => { server.listen(0, '127.0.0.1', r) })
  base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
})
afterEach(async () => { await new Promise((r) => { server.close(r) }); await cleanup() })

async function create(auth: WebhookAuth, events: string[] = []): Promise<{ id: string; secret: string | undefined }> {
  const r = await engine.save({ name: `hook ${auth}`, source: { kind: 'webhook', auth, events }, target: { mode: 'new', cwd: dir }, prompt: 'Do {{event_fenced}}', limits: { maxPerHour: 100, minIntervalSec: 0 } })
  return { id: r.automation.id, secret: r.secret }
}
const post = (id: string, body: string | Buffer, headers: Record<string, string> = {}) => fetch(`${base}${HOOK_BASE}/${id}`, { method: 'POST', body: typeof body === 'string' ? body : new Uint8Array(body), headers })

describe('webhook route', () => {
  it('token: 202 with runId, then delivered asynchronously with the parsed JSON body', async () => {
    const { id, secret } = await create('token')
    const res = await post(id, '{"action":"opened"}', { authorization: `Bearer ${String(secret)}`, 'content-type': 'application/json', 'x-github-event': 'issues', 'x-github-delivery': 'd-1' })
    expect(res.status).toBe(202)
    const json = await res.json() as { accepted: boolean; runId: string }
    expect(json.accepted).toBe(true)
    await until(() => store.run(json.runId)?.status === 'delivered')
    const row = store.run(json.runId)
    expect(row).toMatchObject({ eventId: 'id:d-1', summary: 'POST from 127.0.0.1 (github: issues)', sessionId: 'session-x', source: 'webhook' })
    const text = (deliver.mock.calls[0] as unknown as [unknown, { text: string }])[1].text
    expect(text).toContain('"action": "opened"')
  })

  it('non-JSON body becomes { text }, and sha256(body) is the dedupe id', async () => {
    const { id, secret } = await create('token')
    const r1 = await post(id, 'plain words', { 'x-trigger-token': String(secret) })
    expect(r1.status).toBe(202)
    await until(() => deliver.mock.calls.length === 1)
    expect((deliver.mock.calls[0] as unknown as [unknown, { text: string }])[1].text).toContain('"text": "plain words"')
    const r2 = await post(id, 'plain words', { 'x-trigger-token': String(secret) })
    expect(r2.status).toBe(200)
    expect(await r2.json()).toMatchObject({ duplicate: true })
  })

  it('401 for a wrong secret, logged as rejected without the body', async () => {
    const { id } = await create('token')
    const res = await post(id, 'SECRET-PAYLOAD', { authorization: 'Bearer nope' })
    expect(res.status).toBe(401)
    const row = store.recentRuns()[0]
    expect(row).toMatchObject({ status: 'rejected', reason: 'bad-token', bytes: 14 })
    expect(JSON.stringify(store.recentRuns())).not.toContain('SECRET-PAYLOAD')
    expect(deliver).not.toHaveBeenCalled()
  })

  it('hmac-sha256 and standard-webhooks over the raw bytes', async () => {
    const gh = await create('hmac-sha256')
    const body = Buffer.from('{"zen":"Keep it logically awesome."}')
    expect((await post(gh.id, body, { 'x-hub-signature-256': signHubSha256(String(gh.secret), body) })).status).toBe(202)
    expect((await post(gh.id, body, { 'x-hub-signature-256': signHubSha256('wrong', body) })).status).toBe(401)
    const sw = await create('standard-webhooks')
    const ts = String(Math.floor(Date.now() / 1000))
    expect((await post(sw.id, body, { 'webhook-id': 'msg_1', 'webhook-timestamp': ts, 'webhook-signature': signStandardWebhook(String(sw.secret), 'msg_1', ts, body) })).status).toBe(202)
    const old = String(Math.floor(Date.now() / 1000) - 600)
    expect((await post(sw.id, body, { 'webhook-id': 'msg_2', 'webhook-timestamp': old, 'webhook-signature': signStandardWebhook(String(sw.secret), 'msg_2', old, body) })).status).toBe(401)
  })

  it('none: accepted from direct loopback, rejected when proxied', async () => {
    const { id, secret } = await create('none')
    expect(secret).toBeUndefined()
    expect((await post(id, '{"a":1}')).status).toBe(202)
    expect((await post(id, '{"a":2}', { 'x-forwarded-for': '100.64.0.9' })).status).toBe(401)
  })

  it('404 for unknown and disabled automations (same answer), 405 for GET, 413 over the limit', async () => {
    const { id, secret } = await create('token')
    expect((await post('trg_unknown', '{}')).status).toBe(404)
    expect((await fetch(`${base}${HOOK_BASE}/${id}`)).status).toBe(405)
    const big = Buffer.alloc(MAX_BODY_BYTES + 1, 97)
    expect((await post(id, big, { authorization: `Bearer ${String(secret)}` })).status).toBe(413)
    await engine.setEnabled(id, false)
    const res = await post(id, '{}', { authorization: `Bearer ${String(secret)}` })
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'not-found' })
  })

  it('429 when rate limited, still logged as skipped', async () => {
    const r = await engine.save({ name: 'limited', source: { kind: 'webhook', auth: 'token', events: [] }, target: { cwd: dir }, prompt: 'x', limits: { maxPerHour: 1, minIntervalSec: 0 } })
    const auth = { authorization: `Bearer ${String(r.secret)}` }
    expect((await post(r.automation.id, '{"n":1}', auth)).status).toBe(202)
    const res = await post(r.automation.id, '{"n":2}', auth)
    expect(res.status).toBe(429)
    expect(res.headers.get('retry-after')).toBe('60')
    // Both runs can land in the same millisecond, so don't rely on their order.
    expect(store.recentRuns()).toContainEqual(expect.objectContaining({ status: 'skipped', reason: 'rate-limited' }))
  })

  it('event-type filter answers 202 accepted:false', async () => {
    const { id, secret } = await create('token', ['push'])
    const res = await post(id, '{}', { authorization: `Bearer ${String(secret)}`, 'x-github-event': 'issues' })
    expect(res.status).toBe(202)
    expect(await res.json()).toMatchObject({ accepted: false, filtered: true })
  })

  it('parses ids from the URL safely', () => {
    expect(automationIdFromUrl('/hooks/trg_abc')).toBe('trg_abc')
    expect(automationIdFromUrl('/hooks/trg_abc/?x=1')).toBe('trg_abc')
    expect(automationIdFromUrl('/hooks/../etc')).toBeUndefined()
    expect(automationIdFromUrl('/hooks')).toBeUndefined()
  })
})
