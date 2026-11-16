// @vitest-environment node
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WARN_NO_ACCOUNT, WARN_NOT_INSTALLED, type ComposioServiceLike } from '../../src/host/composio.ts'
import { TriggersEngine } from '../../src/host/engine.ts'
import { routeHandler, serveRoute } from '../../src/host/routes.ts'
import { TriggersStore } from '../../src/host/store.ts'
import { log, tempDir } from './helpers.ts'

let dir: string; let cleanup: () => Promise<void>
beforeEach(async () => { ({ dir, cleanup } = await tempDir('triggers-composio-')) })
afterEach(async () => { await cleanup() })

function fakeComposio() {
  let n = 0
  const instances = new Map<string, { slug: string; account: string; enabled: boolean }>()
  const svc = {
    instances,
    failNext: undefined as string | undefined,
    connections: vi.fn(async () => [
      { slug: 'gmail', name: 'Gmail', logo: null, hasExpired: false, accounts: [
        { id: 'ca_1', wordId: 'brave-otter', alias: 'work', displayName: 'me@work.example', status: 'ACTIVE' },
        { id: 'ca_2', wordId: 'calm-heron', alias: null, displayName: 'me@home.example', status: 'EXPIRED' },
        { id: 'ca_3', wordId: 'quiet-lynx', alias: null, displayName: null, status: 'ACTIVE' },
      ] },
    ]),
    triggerTypes: vi.fn(async (toolkit: string) => [{ slug: `${toolkit.toUpperCase()}_NEW_GMAIL_MESSAGE`, name: 'New message', description: 'Fires on new mail', type: 'poll', instructions: 'none', config: { properties: {} } }]),
    ensureTrigger: vi.fn(async (slug: string, account: string) => {
      if (svc.failNext !== undefined) { const m = svc.failNext; svc.failNext = undefined; throw new Error(m) }
      // Composio upserts: the same slug + account (+ config) gives the same instance.
      for (const [id, i] of instances) if (i.slug === slug && i.account === account) return id
      const id = `ti_${String(++n)}`
      instances.set(id, { slug, account, enabled: true })
      return id
    }),
    releaseTrigger: vi.fn(async (id: string) => { instances.delete(id) }),
    setTriggerEnabled: vi.fn(async (id: string, enabled: boolean) => { const i = instances.get(id); if (i !== undefined) i.enabled = enabled }),
    listenerState: vi.fn(() => ({ state: 'live', lastEventAt: 1, lastError: null })),
  }
  return svc
}

async function setup(composio: ComposioServiceLike | undefined) {
  const store = new TriggersStore(join(dir, 'triggers')); await store.load()
  const engine = new TriggersEngine({
    store, deliver: async () => ({ sessionId: 's' }), origin: () => '', hasAutomationModels: () => false, hasComposio: () => composio !== undefined,
    composio: () => composio, workspaces: () => [], defaultCwd: () => dir, log,
  })
  return { store, engine }
}
const body = (source: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ name: 'Mail', source: { kind: 'composio', triggerSlug: 'GMAIL_NEW_GMAIL_MESSAGE', ...source }, target: { cwd: dir }, prompt: 'x {{event_fenced}}', ...extra })
const instanceOf = (store: TriggersStore, id: string): string | undefined => { const s = store.get(id)?.source; return s?.kind === 'composio' ? s.triggerInstanceId : undefined }

describe('composio trigger instances', () => {
  it('save with an account creates the instance and stores its id; re-save keeps it', async () => {
    const c = fakeComposio(); const { store, engine } = await setup(c)
    const r = await engine.save(body({ connectedAccountId: 'ca_1' }))
    expect(c.ensureTrigger).toHaveBeenCalledWith('GMAIL_NEW_GMAIL_MESSAGE', 'ca_1', {})
    expect(instanceOf(store, r.automation.id)).toBe('ti_1')
    expect(r.warnings).not.toContain(WARN_NO_ACCOUNT)
    await engine.save({ ...body({ connectedAccountId: 'ca_1' }), id: r.automation.id, name: 'Renamed' })
    expect(c.ensureTrigger).toHaveBeenCalledTimes(1)
    expect(c.releaseTrigger).not.toHaveBeenCalled()
    expect(instanceOf(store, r.automation.id)).toBe('ti_1')
  })

  it('changing the account creates a new instance and releases the old one', async () => {
    const c = fakeComposio(); const { store, engine } = await setup(c)
    const r = await engine.save(body({ connectedAccountId: 'ca_1' }))
    await engine.save({ ...body({ connectedAccountId: 'ca_3' }), id: r.automation.id })
    expect(instanceOf(store, r.automation.id)).toBe('ti_2')
    expect(c.releaseTrigger).toHaveBeenCalledWith('ti_1')
  })

  it('switching the source to a webhook releases the instance', async () => {
    const c = fakeComposio(); const { engine } = await setup(c)
    const r = await engine.save(body({ connectedAccountId: 'ca_1' }))
    await engine.save({ id: r.automation.id, name: 'Now a hook', source: { kind: 'webhook', auth: 'token', events: [] }, target: { cwd: dir }, prompt: 'x' })
    expect(c.releaseTrigger).toHaveBeenCalledWith('ti_1')
  })

  it('shared instance: released only with the last automation that uses it', async () => {
    const c = fakeComposio(); const { store, engine } = await setup(c)
    const a = await engine.save(body({ connectedAccountId: 'ca_1' }))
    const b = await engine.save(body({ connectedAccountId: 'ca_1' }, { name: 'Mail 2' }))
    expect(instanceOf(store, b.automation.id)).toBe('ti_1')
    await engine.remove(a.automation.id)
    expect(c.releaseTrigger).not.toHaveBeenCalled()
    await engine.remove(b.automation.id)
    expect(c.releaseTrigger).toHaveBeenCalledWith('ti_1')
  })

  it('setEnabled: the instance stays enabled while any automation on it is enabled', async () => {
    const c = fakeComposio(); const { engine } = await setup(c)
    const a = await engine.save(body({ connectedAccountId: 'ca_1' }))
    const b = await engine.save(body({ connectedAccountId: 'ca_1' }, { name: 'Mail 2' }))
    c.setTriggerEnabled.mockClear()
    await engine.setEnabled(a.automation.id, false)
    expect(c.setTriggerEnabled).toHaveBeenLastCalledWith('ti_1', true)
    await engine.setEnabled(b.automation.id, false)
    expect(c.setTriggerEnabled).toHaveBeenLastCalledWith('ti_1', false)
    await engine.setEnabled(a.automation.id, true)
    expect(c.setTriggerEnabled).toHaveBeenLastCalledWith('ti_1', true)
  })

  it('setEnabled failures are best effort (logged, not thrown)', async () => {
    const c = fakeComposio(); const { engine } = await setup(c)
    const a = await engine.save(body({ connectedAccountId: 'ca_1' }))
    c.setTriggerEnabled.mockRejectedValueOnce(new Error('network down'))
    await expect(engine.setEnabled(a.automation.id, false)).resolves.toBeUndefined()
  })

  it('a Composio error fails the save and stores nothing', async () => {
    const c = fakeComposio(); const { store, engine } = await setup(c)
    c.failNext = 'Connected account is not active'
    await expect(engine.save(body({ connectedAccountId: 'ca_2' }))).rejects.toThrow(/Composio could not create the trigger: Connected account is not active/)
    expect(store.data.automations).toHaveLength(0)
    // an existing automation is left unchanged when the update fails
    const r = await engine.save(body({ connectedAccountId: 'ca_1' }))
    c.failNext = 'boom'
    await expect(engine.save({ ...body({ connectedAccountId: 'ca_3' }), id: r.automation.id, name: 'Changed' })).rejects.toThrow(/boom/)
    expect(store.get(r.automation.id)?.name).toBe('Mail')
    expect(instanceOf(store, r.automation.id)).toBe('ti_1')
    expect(c.releaseTrigger).not.toHaveBeenCalled()
  })

  it('warnings: plugin missing, account missing; a hand-typed instance id is never released or toggled', async () => {
    const missing = await setup(undefined)
    const r1 = await missing.engine.save(body({ connectedAccountId: 'ca_1' }))
    expect(r1.warnings).toContain(WARN_NOT_INSTALLED)
    expect(instanceOf(missing.store, r1.automation.id)).toBeUndefined()

    const c = fakeComposio(); const { engine } = await setup(c)
    const r2 = await engine.save(body({}))
    expect(r2.warnings).toContain(WARN_NO_ACCOUNT)
    const r3 = await engine.save(body({ triggerInstanceId: 'ti_manual' }))
    expect(r3.warnings).not.toContain(WARN_NO_ACCOUNT)
    await engine.setEnabled(r3.automation.id, false)
    await engine.remove(r3.automation.id)
    expect(c.ensureTrigger).not.toHaveBeenCalled()
    expect(c.releaseTrigger).not.toHaveBeenCalled()
    expect(c.setTriggerEnabled).not.toHaveBeenCalled()
  })

  it('ingest: an automation without instance id matches every event of its slug', async () => {
    const { engine } = await setup(fakeComposio())
    await engine.save(body({}, { limits: { maxPerHour: 100, minIntervalSec: 0 } }))
    expect(await engine.ingest({ source: 'composio', triggerSlug: 'GMAIL_NEW_GMAIL_MESSAGE', triggerInstanceId: 'ti_any', eventId: 'e1', data: {} })).toEqual({ matched: 1 })
    expect(await engine.ingest({ source: 'composio', triggerSlug: 'GMAIL_NEW_GMAIL_MESSAGE', eventId: 'e2', data: {} })).toEqual({ matched: 1 })
    expect(await engine.ingest({ source: 'composio', triggerSlug: 'SLACK_NEW_MESSAGE', eventId: 'e3', data: {} })).toEqual({ matched: 0 })
  })

  it('ingest: an automation with an instance id matches only that instance', async () => {
    const c = fakeComposio(); const { engine } = await setup(c)
    await engine.save(body({ connectedAccountId: 'ca_1' }, { limits: { maxPerHour: 100, minIntervalSec: 0 } }))
    expect(await engine.ingest({ source: 'composio', triggerSlug: 'GMAIL_NEW_GMAIL_MESSAGE', triggerInstanceId: 'ti_other', eventId: 'e1', data: {} })).toEqual({ matched: 0 })
    expect(await engine.ingest({ source: 'composio', triggerSlug: 'GMAIL_NEW_GMAIL_MESSAGE', triggerInstanceId: 'ti_1', eventId: 'e2', data: {} })).toEqual({ matched: 1 })
  })
})

describe('composio page routes', () => {
  const call = async (handle: ReturnType<typeof routeHandler>, method: string, payload: unknown) => {
    const request = new Request(`http://127.0.0.1:3080/api/triggers/${method}`, { method: 'POST', body: JSON.stringify(payload), headers: { host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080' } })
    const res = await serveRoute(method, request, { connection: { requestRejection: () => undefined }, handle, log })
    return { status: res.status, json: await res.json() as { ok: boolean; value?: unknown; error?: { code: string; message: string } } }
  }

  it('composioAccounts: toolkits with labelled accounts and the listener state', async () => {
    const c = fakeComposio(); const { store, engine } = await setup(c)
    const handle = routeHandler({ engine, store, modelCatalog: async () => null })
    const r = await call(handle, 'composioAccounts', {})
    expect(r.json).toEqual({ ok: true, value: {
      available: true,
      toolkits: [{ slug: 'gmail', name: 'Gmail', accounts: [
        { id: 'ca_1', label: 'work', status: 'ACTIVE' },
        { id: 'ca_2', label: 'me@home.example', status: 'EXPIRED' },
        { id: 'ca_3', label: 'Account 3', status: 'ACTIVE' },
      ] }],
      listener: { state: 'live', lastError: null },
    } })
  })

  it('composioAccounts without the plugin, and with a failing Composio', async () => {
    const none = await setup(undefined)
    const handleNone = routeHandler({ engine: none.engine, store: none.store, modelCatalog: async () => null })
    expect((await call(handleNone, 'composioAccounts', {})).json).toEqual({ ok: true, value: { available: false, toolkits: [], listener: null } })
    expect(none.engine.state().hasComposio).toBe(false)

    const c = fakeComposio(); c.connections.mockRejectedValueOnce(new Error('no credentials'))
    const { store, engine } = await setup(c)
    const r = await call(routeHandler({ engine, store, modelCatalog: async () => null }), 'composioAccounts', {})
    expect(r.json).toEqual({ ok: true, value: { available: true, toolkits: [], listener: { state: 'live', lastError: null }, error: 'no credentials' } })
  })

  it('composioTriggerTypes: slug, name, description, instructions; validates the toolkit', async () => {
    const c = fakeComposio(); const { store, engine } = await setup(c)
    const handle = routeHandler({ engine, store, modelCatalog: async () => null })
    expect((await call(handle, 'composioTriggerTypes', { toolkit: 'gmail' })).json).toEqual({ ok: true, value: [
      { slug: 'GMAIL_NEW_GMAIL_MESSAGE', name: 'New message', description: 'Fires on new mail', instructions: 'none' },
    ] })
    expect((await call(handle, 'composioTriggerTypes', {})).json).toEqual({ ok: false, error: { code: 'bad-request', message: 'toolkit is required' } })
    expect((await call(handle, 'composioTriggerTypes', { toolkit: '../x' })).json.error?.code).toBe('bad-request')
    const none = await setup(undefined)
    expect((await call(routeHandler({ engine: none.engine, store: none.store, modelCatalog: async () => null }), 'composioTriggerTypes', { toolkit: 'gmail' })).json.error).toEqual({ code: 'bad-request', message: WARN_NOT_INSTALLED })
  })

  it('save route maps a Composio failure to bad-request with its message', async () => {
    const c = fakeComposio(); c.failNext = 'Trigger config invalid'
    const { store, engine } = await setup(c)
    const r = await call(routeHandler({ engine, store, modelCatalog: async () => null }), 'save', body({ connectedAccountId: 'ca_1' }))
    expect(r.json).toEqual({ ok: false, error: { code: 'bad-request', message: 'Composio could not create the trigger: Trigger config invalid' } })
  })

  it('routes fail closed and reject cross-origin', async () => {
    const { store, engine } = await setup(undefined)
    const handle = routeHandler({ engine, store, modelCatalog: async () => null })
    const rejected = await serveRoute('state', new Request('http://x/api/triggers/state', { method: 'POST', body: '{}' }), { connection: { requestRejection: () => 401 }, handle, log })
    expect(rejected.status).toBe(401)
    const throwing = await serveRoute('state', new Request('http://x/api/triggers/state', { method: 'POST', body: '{}' }), { connection: { requestRejection: () => { throw new Error('x') } }, handle, log })
    expect(throwing.status).toBe(503)
    const cross = await serveRoute('state', new Request('http://127.0.0.1:3080/api/triggers/state', { method: 'POST', body: '{}', headers: { host: '127.0.0.1:3080', origin: 'https://evil.example' } }), { connection: { requestRejection: () => undefined }, handle, log })
    expect(cross.status).toBe(403)
  })
})
