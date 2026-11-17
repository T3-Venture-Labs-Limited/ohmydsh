// @vitest-environment node
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TriggersEngine, type EngineDeps } from '../../src/host/engine.ts'
import { rateDecision, RejectLimiter, TriggersStore } from '../../src/host/store.ts'
import type { TriggerEvent } from '../../src/host/prompt.ts'
import type { RunRow } from '../../src/shared/types.ts'
import { automation, log, tempDir } from './helpers.ts'

let dir: string; let cleanup: () => Promise<void>
beforeEach(async () => { ({ dir, cleanup } = await tempDir()) })
afterEach(async () => { await cleanup() })

async function setup(extra: Partial<EngineDeps> = {}) {
  const store = new TriggersStore(join(dir, 'triggers'))
  await store.load()
  const deliver = vi.fn(async () => ({ sessionId: 'session-1', model: 'p/m' }))
  let clock = 1_800_000_000_000
  const engine = new TriggersEngine({
    store, deliver, origin: () => 'http://127.0.0.1:3080', hasAutomationModels: () => false, hasComposio: () => false,
    workspaces: () => [], defaultCwd: () => dir, log, now: () => clock, ...extra,
  })
  return { store, engine, deliver, tick: (ms: number) => { clock += ms }, now: () => clock }
}
const ev = (id: string, now: number, extra: Partial<TriggerEvent> = {}): TriggerEvent => ({ source: 'webhook', eventId: id, data: { n: id }, summary: 'POST', bytes: 2, receivedAt: now, ...extra })

describe('engine firing', () => {
  it('logs pending then delivered with one row per runId (latest wins), passes rendered prompt and title', async () => {
    const { store, engine, deliver, now } = await setup()
    const a = automation({ target: { title: 'Hook {{event.n}}' } }); store.data.automations.push(a)
    const out = await engine.fire(a, ev('id:1', now()))
    expect(out.row.status).toBe('pending')
    const final = await out.done
    expect(final).toMatchObject({ runId: out.row.runId, status: 'delivered', sessionId: 'session-1', model: 'p/m' })
    expect(deliver).toHaveBeenCalledWith(a, expect.objectContaining({ runId: out.row.runId, title: 'Hook id:1', text: expect.stringContaining('<untrusted_event>') }))
    expect(store.recentRuns().filter((r) => r.runId === out.row.runId)).toEqual([final])
    const lines = (await readFile(store.runsPath, 'utf8')).trim().split('\n')
    expect(lines).toHaveLength(2)
    // reload: latest line per runId wins
    const again = new TriggersStore(store.dir); await again.load()
    expect(again.recentRuns()).toEqual([final])
    expect((await stat(store.runsPath)).mode & 0o777).toBe(0o600)
  })

  it('drops duplicate event ids (persisted) and logs skipped: duplicate', async () => {
    const { store, engine, tick, now } = await setup()
    const a = automation({ limits: { maxPerHour: 100, minIntervalSec: 0 } }); store.data.automations.push(a)
    await (await engine.fire(a, ev('id:dup', now()))).done
    tick(1000)
    const second = await engine.fire(a, ev('id:dup', now()))
    expect(second.row).toMatchObject({ status: 'skipped', reason: 'duplicate' })
    await store.flushed()
    const reloaded = new TriggersStore(store.dir); await reloaded.load()
    expect(reloaded.hasSeen(a.id, 'id:dup')).toBe(true)
    expect(reloaded.hasSeen('other', 'id:dup')).toBe(false)
  })

  it('skips disabled, paused and filtered events; test events bypass enabled/paused/limits', async () => {
    const { store, engine, deliver, now } = await setup()
    const a = automation({ enabled: false, source: { kind: 'webhook', auth: 'token', events: ['push'] } }); store.data.automations.push(a)
    expect((await engine.fire(a, ev('id:a', now(), { eventType: 'push' }))).row.reason).toBe('disabled')
    a.enabled = true; store.data.paused = true
    expect((await engine.fire(a, ev('id:b', now(), { eventType: 'push' }))).row.reason).toBe('paused')
    store.data.paused = false
    expect((await engine.fire(a, ev('id:c', now(), { eventType: 'issues' }))).row.reason).toBe('filtered')
    a.enabled = false; store.data.paused = true
    const t = await engine.fire(a, ev('test:1', now(), { test: true }))
    expect((await t.done).status).toBe('delivered')
    expect(t.row.test).toBe(true)
    expect(deliver).toHaveBeenCalledTimes(1)
  })

  it('rate limits: min interval, per hour, global — logged as skipped', async () => {
    const { store, engine, tick, now } = await setup()
    const a = automation({ limits: { maxPerHour: 2, minIntervalSec: 10 } }); store.data.automations.push(a)
    expect((await engine.fire(a, ev('id:1', now()))).row.status).toBe('pending')
    tick(5000)
    expect((await engine.fire(a, ev('id:2', now()))).row.reason).toBe('min-interval')
    tick(6000)
    expect((await engine.fire(a, ev('id:3', now()))).row.status).toBe('pending')
    tick(11_000)
    expect((await engine.fire(a, ev('id:4', now()))).row.reason).toBe('rate-limited')
    tick(3_600_000)
    expect((await engine.fire(a, ev('id:5', now()))).row.status).toBe('pending')
    // a rate-limited event is NOT marked seen: a retry later is accepted
    expect(store.hasSeen(a.id, 'id:4')).toBe(false)
  })

  it('global hourly limit', () => {
    const fake = { countedSince: (_s: number, id?: string) => (id === undefined ? 60 : 0), lastCountedAt: () => 0 }
    expect(rateDecision(fake, automation(), 10_000_000)).toBe('global-rate-limited')
  })

  it('auto-disables after 3 consecutive failures; success resets the counter', async () => {
    const deliver = vi.fn(async () => { throw new Error('boom') })
    const { store, engine, tick, now } = await setup({ deliver })
    const a = automation({ limits: { maxPerHour: 100, minIntervalSec: 0 } }); store.data.automations.push(a)
    for (const i of [1, 2, 3]) { tick(10); const out = await engine.fire(a, ev(`id:${String(i)}`, now())); expect((await out.done).status).toBe('failed') }
    expect(a.enabled).toBe(false)
    expect(a.consecutiveFailures).toBe(3)
    await engine.setEnabled(a.id, true)
    expect(a.consecutiveFailures).toBe(0)
  })

  it('rejected-row limiter allows 10 per minute', () => {
    const l = new RejectLimiter(10)
    for (let i = 0; i < 10; i++) expect(l.allow(1000 + i)).toBe(true)
    expect(l.allow(2000)).toBe(false)
    expect(l.allow(62_000)).toBe(true)
  })
})

describe('composio ingest', () => {
  it('matches by slug and (when set) instance id', async () => {
    const { store, engine } = await setup()
    store.data.automations.push(
      automation({ id: 'a1', limits: { maxPerHour: 100, minIntervalSec: 0 }, source: { kind: 'composio', triggerSlug: 'GMAIL_NEW_GMAIL_MESSAGE' } }),
      automation({ id: 'a2', limits: { maxPerHour: 100, minIntervalSec: 0 }, source: { kind: 'composio', triggerSlug: 'GMAIL_NEW_GMAIL_MESSAGE', triggerInstanceId: 'ti_2' } }),
      automation({ id: 'a3', limits: { maxPerHour: 100, minIntervalSec: 0 }, source: { kind: 'composio', triggerSlug: 'SLACK_X' } }),
    )
    expect(await engine.ingest({ source: 'composio', triggerSlug: 'GMAIL_NEW_GMAIL_MESSAGE', triggerInstanceId: 'ti_1', eventId: 'e1', data: { subject: 'hi' } })).toEqual({ matched: 1 })
    expect(await engine.ingest({ source: 'composio', triggerSlug: 'gmail_new_gmail_message', triggerInstanceId: 'ti_2', eventId: 'e2', data: {} })).toEqual({ matched: 2 })
    expect(await engine.ingest({ source: 'composio', triggerSlug: 'GMAIL_NEW_GMAIL_MESSAGE', triggerInstanceId: 'ti_2', eventId: 'e2', data: {} })).toEqual({ matched: 0 }) // duplicate
  })
})

describe('management', () => {
  it('save creates a webhook automation with a secret returned once, stored 0600, never in the view', async () => {
    const { store, engine } = await setup()
    const r = await engine.save({ name: 'GH', source: { kind: 'webhook', auth: 'hmac-sha256', events: [] }, target: { mode: 'new', cwd: dir, model: null, sandbox: 'read-only', tools: 'read', title: '' }, prompt: 'Do {{event_fenced}}' })
    expect(r.secret).toMatch(/^whsec_/)
    expect(r.automation.webhookUrl).toBe(`http://127.0.0.1:3080/hooks/${r.automation.id}`)
    expect(JSON.stringify(engine.state())).not.toContain(r.secret)
    expect(r.automation.secretHint).toMatch(/^whsec_/)
    await store.flushed()
    expect((await stat(join(store.dir, 'secrets.json'))).mode & 0o777).toBe(0o600)
    expect((await stat(join(store.dir, 'automations.json'))).mode & 0o777).toBe(0o600)
    const updated = await engine.save({ id: r.automation.id, name: 'GH2', source: { kind: 'webhook', auth: 'hmac-sha256', events: ['push'] }, target: { cwd: dir }, prompt: 'x' })
    expect(updated.secret).toBeUndefined()
    const rotated = await engine.rotateSecret(r.automation.id)
    expect(rotated.secret).not.toBe(r.secret)
  })

  it('validates input', async () => {
    const { engine } = await setup()
    await expect(engine.save({ name: '', source: { kind: 'webhook' }, target: {}, prompt: 'x' })).rejects.toThrow(/name/)
    await expect(engine.save({ name: 'a', source: { kind: 'file', path: 'relative', pattern: '*.md' }, target: {}, prompt: 'x' })).rejects.toThrow(/absolute/)
    await expect(engine.save({ name: 'a', source: { kind: 'webhook', auth: 'basic' }, target: {}, prompt: 'x' })).rejects.toThrow(/auth/)
    await expect(engine.save({ name: 'a', source: { kind: 'webhook' }, target: { sandbox: 'danger-full-access' }, prompt: 'x' })).rejects.toThrow(/sandbox/)
  })

  it('test fires with a sample event and preview returns the exact prompt', async () => {
    const { store, engine } = await setup()
    const a = automation({ enabled: false }); store.data.automations.push(a)
    const row: RunRow = await engine.test(a.id, { hello: 'x' })
    expect(row).toMatchObject({ status: 'delivered', test: true })
    const p = await engine.preview(a, { hello: '<b>' })
    expect(p.prompt).toContain('\\u003cb\\u003e')
    expect(p.title).toBe('Test automation')
  })
})

describe('restart recovery', () => {
  it('reports pending rows left by a previous process', async () => {
    const { store, engine, now } = await setup({ deliver: () => new Promise(() => {}) })
    const a = automation(); store.data.automations.push(a)
    const out = await engine.fire(a, ev('id:hang', now()))
    const again = new TriggersStore(store.dir); await again.load()
    expect(again.pendingRuns().map((r) => r.runId)).toEqual([out.row.runId])
  })
})
