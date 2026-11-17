// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { RunLauncher, runToolGuard, MAX_QUEUE, type AgentLike } from '../src/host/launcher.ts'
import { DEFAULT_LIMITS, instanceStillUsed, rateDecision, type Recipe, type Route } from '../src/host/store.ts'
import { leaseFree } from '../src/host/listener.ts'
import type { NormalizedEvent } from '../src/host/events.ts'

const event: NormalizedEvent = { eventId: 'e1', triggerId: 'ti_1', triggerSlug: 'S', toolkit: 'github', connectedAccountId: 'ca', userId: 'u', timestamp: 't', version: 'V3', data: { title: 'hi' } }
const recipe: Recipe = { id: 'rcp', name: 'R', promptTemplate: 'Go {{event_fenced}}', model: null, allowToolkits: ['github'], allowTools: [], sandbox: 'read-only', payload: {}, createdAt: 0, updatedAt: 0 }
const route = (target: Route['target']): Route => ({ id: 'rt', name: 'Route', enabled: true, triggerSlug: 'S', toolkit: 'github', connectedAccountId: 'ca', triggerConfig: {}, triggerInstanceId: 'ti_1', recipeId: 'rcp', target, limits: DEFAULT_LIMITS, consecutiveFailures: 0, createdAt: 0 })

function agent(status = 'idle'): AgentLike & { appended: [string, unknown][]; followups: unknown[]; selected: unknown[] } {
  const appended: [string, unknown][] = []; const followups: unknown[] = []; const selected: unknown[] = []
  return {
    id: 'a1', status, appended, followups, selected,
    ctx: { tools: { guard: () => () => {} }, effect: (fn) => { fn() } },
    session: { append: (t, d) => { appended.push([t, d]) } },
    model: { current: () => ({ provider: 'claude', model: 'claude-haiku-5-5' }), select: (r) => { selected.push(r) } },
    followup: (m) => { followups.push(m) },
  }
}
function deps(a: AgentLike, extra: Partial<ConstructorParameters<typeof RunLauncher>[0]> = {}) {
  const create = vi.fn(async () => ({}))
  const applyModel = vi.fn(() => true)
  const restrictRun = vi.fn()
  const base: ConstructorParameters<typeof RunLauncher>[0] = {
    controller: () => ({ create, resolveAgent: async () => ({ agent: a }) }),
    liveAgent: () => a, archived: () => false, makeMessage: (text, pinned) => ({ text, pinned }),
    flush: async () => true, rename: () => {}, attachWorkspace: async () => {}, applyModel, restrictRun, pinTurn: vi.fn(), log: { info: () => {}, warn: () => {} },
  }
  return { d: { ...base, ...extra }, create, applyModel, restrictRun }
}

describe('new-session run', () => {
  it('creates with a reserved id, pins sandbox, restricts tools, then followup with the fenced prompt', async () => {
    const a = agent(); const { d, create, restrictRun } = deps(a)
    const result = await new RunLauncher(d).launchNew(recipe, route({ mode: 'new-session' }), event, 'session-fixed')
    expect(create).toHaveBeenCalledWith({ sessionId: 'session-fixed' })
    expect(result.sessionId).toBe('session-fixed')
    expect(a.appended).toContainEqual(['sandbox/mode', { mode: 'read-only' }])
    expect(restrictRun).toHaveBeenCalled()
    expect(a.followups).toHaveLength(1)
    expect(JSON.stringify(a.followups[0])).toContain('<untrusted_event>')
  })
  it('applies the recipe model without ever touching a global default', async () => {
    const a = agent(); const { d, applyModel } = deps(a)
    await new RunLauncher(d).launchNew({ ...recipe, model: { provider: 'claude', model: 'claude-sonnet-5-5', reasoningEffort: 'low' } }, route({ mode: 'new-session' }), event)
    expect(applyModel).toHaveBeenCalledWith(a, { provider: 'claude', model: 'claude-sonnet-5-5', reasoningEffort: 'low' }, 'never')
  })
  it('fails when persistence does not acknowledge', async () => {
    const a = agent(); const { d } = deps(a, { flush: async () => false })
    await expect(new RunLauncher(d).launchNew(recipe, route({ mode: 'new-session' }), event)).rejects.toThrow(/acknowledge/)
  })
})

describe('existing-session wake', () => {
  const target = route({ mode: 'existing-session', sessionId: 's1', acknowledged: true }) as Route & { target: { mode: 'existing-session'; sessionId: string } }
  it('follows up when idle and does not pin the user\'s model', async () => {
    const a = agent('idle'); const { d, applyModel } = deps(a)
    const r = await new RunLauncher(d).launchExisting(recipe, target, event)
    expect(r).toEqual({ sessionId: 's1' })
    expect(a.followups).toHaveLength(1)
    expect(applyModel).not.toHaveBeenCalled()
  })
  it('queues while busy (bounded, drop-oldest) and batches on idle with ---', async () => {
    const a = agent('running'); const { d } = deps(a); const l = new RunLauncher(d)
    for (let i = 0; i < MAX_QUEUE + 3; i++) expect((await l.launchExisting(recipe, target, { ...event, eventId: `e${String(i)}` })).queued).toBe(true)
    expect(l.queued).toBe(MAX_QUEUE)
    expect(a.followups).toHaveLength(0)
    expect(l.flushQueue('s1', a)).toBe(true)
    expect(a.followups).toHaveLength(1)
    expect(JSON.stringify(a.followups[0])).toContain('---')
    expect(l.queued).toBe(0)
  })
  it('refuses archived targets and subagents', async () => {
    const a = agent(); await expect(new RunLauncher(deps(a, { archived: () => true }).d).launchExisting(recipe, target, event)).rejects.toThrow(/archived/)
    const sub = { ...agent(), session: { header: { origin: 'subagent' }, append: () => {} } } as AgentLike
    await expect(new RunLauncher(deps(sub).d).launchExisting(recipe, target, event)).rejects.toThrow(/subagent/)
  })
})

describe('trigger-run guard, limits, lease', () => {
  it('allows composio_* and read tools, denies the rest', () => {
    expect(runToolGuard({ name: 'composio_execute' })).toBeUndefined()
    expect(runToolGuard({ name: 'read' })).toBeUndefined()
    expect(runToolGuard({ name: 'bash' })).toMatch(/not available/)
    expect(runToolGuard({ name: 'write' })).toMatch(/not available/)
  })
  it('rate decisions: min interval, per-route hourly, global', () => {
    const store = (last: number, hour: number, global: number) => ({ lastDeliveredAt: () => last, deliveredSince: () => hour, globalDeliveredSince: () => global })
    const now = 10_000_000
    expect(rateDecision(store(now - 1000, 0, 0), route({ mode: 'new-session' }), now)).toBe('min-interval')
    expect(rateDecision(store(0, 6, 0), route({ mode: 'new-session' }), now)).toBe('rate-limited')
    expect(rateDecision(store(0, 0, 30), route({ mode: 'new-session' }), now)).toBe('global-rate-limited')
    expect(rateDecision(store(0, 0, 0), route({ mode: 'new-session' }), now)).toBeUndefined()
  })
  it('lease: free when absent/ours/stale/dead owner, held by a live fresh owner', () => {
    const now = 1_000_000
    expect(leaseFree(undefined, 't', now, () => true)).toBe(true)
    expect(leaseFree({ pid: 1, at: now, token: 't' }, 't', now, () => true)).toBe(true)
    expect(leaseFree({ pid: 1, at: now - 40_000, token: 'o' }, 't', now, () => true)).toBe(true)
    expect(leaseFree({ pid: 1, at: now, token: 'o' }, 't', now, () => false)).toBe(true)
    expect(leaseFree({ pid: 1, at: now, token: 'o' }, 't', now, () => true)).toBe(false)
  })
  it('routes may share one Composio trigger instance: delete it only with the last route', () => {
    const routes = [{ triggerInstanceId: 'ti_a' }, { triggerInstanceId: 'ti_a' }, { triggerInstanceId: 'ti_b' }]
    expect(instanceStillUsed(routes.slice(1), 'ti_a')).toBe(true)
    expect(instanceStillUsed(routes.slice(2), 'ti_a')).toBe(false)
  })
})
