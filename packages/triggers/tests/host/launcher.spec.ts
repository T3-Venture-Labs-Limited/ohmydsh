// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { MAX_QUEUE, RunLauncher, type AgentLike, type LauncherDeps } from '../../src/host/launcher.ts'
import { PinError, readToolGuard, stricter, TurnPins } from '../../src/host/pin.ts'
import type { QueuedDelivery } from '../../src/host/store.ts'
import type { Automation } from '../../src/shared/types.ts'
import { automation, log } from './helpers.ts'

type FakeAgent = AgentLike & { appended: [string, unknown][]; followups: { text: string; automationId: string; pinned: boolean }[]; guards: ((e: { name: string }) => string | undefined)[]; mode: string; status: string; selected: unknown[] }

function agent(id = 'session-a', status = 'idle', mode = 'workspace-write'): FakeAgent {
  const a: FakeAgent = {
    id, status, mode, appended: [], followups: [], guards: [], selected: [],
    ctx: {
      tools: { guard: (g) => { a.guards.push(g); return () => { a.guards = a.guards.filter((x) => x !== g) } } },
      effect: (fn) => { fn() },
    },
    session: { append: (t, d) => { a.appended.push([t, d]); if (t === 'sandbox/mode') a.mode = (d as { mode: string }).mode } },
    model: { current: () => ({ provider: 'claude', model: 'haiku' }), select: (r) => { a.selected.push(r) } },
    followup: (m) => { a.followups.push(m as FakeAgent['followups'][number]) },
  }
  return a
}

function deps(agents: Map<string, FakeAgent>, store: Map<string, Automation>, extra: Partial<LauncherDeps> = {}) {
  const created: string[] = []
  const queue = { items: {} as Record<string, QueuedDelivery[]>, save: vi.fn(async () => {}) }
  const results: { ids: readonly string[]; result: unknown }[] = []
  const pins = new TurnPins({ currentMode: (x) => (x as FakeAgent).mode, log })
  const applyModel = vi.fn((a: AgentLike, route: { provider: string; model: string }, restore: 'idle' | 'never') => { if (restore === 'never') a.model.select(route); return true })
  const d: LauncherDeps = {
    controller: () => ({
      create: async ({ sessionId }) => { created.push(sessionId); agents.set(sessionId, agent(sessionId)) },
      resolveAgent: async (id) => { const a = agents.get(id); return a === undefined ? { error: new Error('missing') } : { agent: a } },
    }),
    liveAgent: (id) => agents.get(id),
    archived: () => false,
    makeMessage: (text, automationId, pinned) => ({ text, automationId, pinned }),
    flush: async () => true,
    rename: vi.fn(),
    attachWorkspace: vi.fn(async () => {}),
    applyModel,
    currentMode: (a) => (a as FakeAgent).mode,
    pinTurn: (a, policy) => { pins.apply(a, a.id, policy) },
    queue,
    automation: (id) => store.get(id),
    setReuseSession: async (id, sessionId) => { const a = store.get(id); if (a !== undefined) a.target.sessionId = sessionId },
    onQueueResult: (ids, result) => { results.push({ ids, result }) },
    log,
    ...extra,
  }
  return { d, created, queue, results, pins, applyModel }
}
const delivery = (runId: string, text = `event ${runId}`) => ({ runId, text, title: 'T' })

describe('new chat per event', () => {
  it('creates, attaches the workspace, tightens sandbox, guards tools, names, follows up, flushes', async () => {
    const agents = new Map<string, FakeAgent>(); const a = automation()
    const { d, created } = deps(agents, new Map([[a.id, a]]))
    const r = await new RunLauncher(d).launchNew(a, delivery('r1'), 'session-fixed')
    expect(created).toEqual(['session-fixed'])
    expect(r).toEqual({ sessionId: 'session-fixed', model: 'claude/haiku' })
    const s = agents.get('session-fixed') as FakeAgent
    expect(d.attachWorkspace).toHaveBeenCalledWith('session-fixed', '/tmp')
    expect(s.appended).toContainEqual(['sandbox/mode', { mode: 'read-only' }])
    expect(s.guards).toHaveLength(1)
    expect(s.guards[0]?.({ name: 'bash' })).toMatch(/not available/)
    expect(s.guards[0]?.({ name: 'read' })).toBeUndefined()
    expect(d.rename).toHaveBeenCalledWith(s, 'T')
    expect(s.followups).toEqual([{ text: 'event r1', automationId: a.id, pinned: false }])
  })

  it('never loosens the sandbox: a read-only profile stays read-only for a workspace-write automation', async () => {
    const agents = new Map<string, FakeAgent>(); const a = automation({ target: { sandbox: 'workspace-write' } })
    const { d } = deps(agents, new Map([[a.id, a]]), {
      controller: () => ({ create: async ({ sessionId }) => { agents.set(sessionId, agent(sessionId, 'idle', 'read-only')) }, resolveAgent: async (id) => ({ agent: agents.get(id) as FakeAgent }) }),
    })
    await new RunLauncher(d).launchNew(a, delivery('r1'), 's1')
    const s = agents.get('s1') as FakeAgent
    expect(s.mode).toBe('read-only')
    expect(s.appended.filter(([t]) => t === 'sandbox/mode')).toEqual([])
  })

  it('applies an explicit model as pinned on the new chat; tools "standard" installs no guard', async () => {
    const agents = new Map<string, FakeAgent>(); const a = automation({ target: { model: { provider: 'claude', model: 'sonnet' }, tools: 'standard' } })
    const { d, applyModel } = deps(agents, new Map([[a.id, a]]))
    await new RunLauncher(d).launchNew(a, delivery('r1'), 's1')
    const s = agents.get('s1') as FakeAgent
    expect(applyModel).toHaveBeenCalledWith(s, { provider: 'claude', model: 'sonnet' }, 'never')
    expect(s.followups[0]?.pinned).toBe(true)
    expect(s.guards).toHaveLength(0)
  })

  it('fails when persistence does not acknowledge', async () => {
    const a = automation(); const { d } = deps(new Map(), new Map([[a.id, a]]), { flush: async () => false })
    await expect(new RunLauncher(d).launchNew(a, delivery('r1'))).rejects.toThrow(/acknowledge/)
  })
})

describe('one reused chat', () => {
  it('creates the chat on the first event and wakes it afterwards', async () => {
    const agents = new Map<string, FakeAgent>(); const a = automation({ target: { mode: 'reuse' } })
    const { d, created } = deps(agents, new Map([[a.id, a]]))
    const l = new RunLauncher(d)
    const first = await l.deliver(a, delivery('r1'))
    expect(created).toHaveLength(1)
    expect(a.target.sessionId).toBe(first.sessionId)
    const s = agents.get(first.sessionId) as FakeAgent
    s.guards = [] // a human message lifted the first pin
    const second = await l.deliver(a, delivery('r2'))
    expect(second.sessionId).toBe(first.sessionId)
    expect(created).toHaveLength(1)
    expect(s.followups.map((f) => f.text)).toEqual(['event r1', 'event r2'])
  })

  it('recreates the chat when the old one is archived', async () => {
    const agents = new Map<string, FakeAgent>([['old', agent('old')]]); const a = automation({ target: { mode: 'reuse', sessionId: 'old' } })
    const { d, created } = deps(agents, new Map([[a.id, a]]), { archived: (id) => id === 'old' })
    const r = await new RunLauncher(d).deliver(a, delivery('r1'))
    expect(created).toHaveLength(1)
    expect(r.sessionId).not.toBe('old')
    expect(a.target.sessionId).toBe(r.sessionId)
  })

  it('queues while busy (bounded 8, drop-oldest, persisted) and flushes on idle as one batched followup', async () => {
    const busy = agent('chat', 'running', 'workspace-write')
    const agents = new Map([['chat', busy]]); const a = automation({ target: { mode: 'reuse', sessionId: 'chat' } })
    const { d, queue, results } = deps(agents, new Map([[a.id, a]]))
    const l = new RunLauncher(d)
    for (let i = 0; i < MAX_QUEUE + 2; i++) expect((await l.deliver(a, delivery(`r${String(i)}`))).queued).toBe(true)
    expect(l.queued).toBe(MAX_QUEUE)
    expect(queue.save).toHaveBeenCalled()
    expect(results.flatMap((r) => r.ids)).toEqual(['r0', 'r1'])
    expect(results[0]?.result).toEqual({ dropped: true, reason: 'queue-full' })
    expect(busy.followups).toHaveLength(0)
    expect(await l.flushQueue(busy)).toBe(false) // still running
    busy.status = 'idle'
    expect(await l.flushQueue(busy)).toBe(true)
    expect(busy.followups).toHaveLength(1)
    expect(busy.followups[0]?.text.split('\n\n---\n\n')).toHaveLength(MAX_QUEUE)
    expect(l.queued).toBe(0)
    expect(results.at(-1)).toEqual({ ids: ['r2', 'r3', 'r4', 'r5', 'r6', 'r7', 'r8', 'r9'], result: { sessionId: 'chat', model: 'claude/haiku' } })
    // the woken turn is pinned: guard on, sandbox tightened from workspace-write to read-only
    expect(busy.guards).toHaveLength(1)
    expect(busy.mode).toBe('read-only')
  })

  it('a wake does not change the user\'s model without automation-models (restore "idle" refused)', async () => {
    const chat = agent('chat'); const a = automation({ target: { mode: 'reuse', sessionId: 'chat', model: { provider: 'x', model: 'y' } } })
    const applyModel = vi.fn(() => false)
    const { d } = deps(new Map([['chat', chat]]), new Map([[a.id, a]]), { applyModel })
    await new RunLauncher(d).deliver(a, delivery('r1'))
    expect(applyModel).toHaveBeenCalledWith(chat, { provider: 'x', model: 'y' }, 'idle')
    expect(chat.selected).toEqual([])
    expect(chat.followups[0]?.pinned).toBe(false)
  })

  it('refuses to wake a chat whose sandbox mode is unknown', async () => {
    const chat = agent('chat'); const a = automation({ target: { mode: 'reuse', sessionId: 'chat' } })
    const pins = new TurnPins({ currentMode: () => undefined, log })
    const { d } = deps(new Map([['chat', chat]]), new Map([[a.id, a]]), { pinTurn: (x, p) => { pins.apply(x, x.id, p) } })
    await expect(new RunLauncher(d).deliver(a, delivery('r1'))).rejects.toBeInstanceOf(PinError)
    expect(chat.followups).toHaveLength(0)
  })
})

describe('pins', () => {
  it('lifts guard and restores the sandbox on a human turn, not on a trigger turn', () => {
    const chat = agent('chat', 'idle', 'workspace-write')
    const pins = new TurnPins({ currentMode: (x) => (x as FakeAgent).mode, log })
    pins.apply(chat, 'chat', { guard: true, sandbox: 'read-only' })
    expect(chat.mode).toBe('read-only'); expect(chat.guards).toHaveLength(1)
    pins.onClaimed(chat, { source: { kind: 'trigger' } })
    expect(chat.guards).toHaveLength(1)
    pins.onClaimed(chat, { source: { kind: 'user' } })
    expect(chat.guards).toHaveLength(0)
    expect(chat.mode).toBe('workspace-write')
  })

  it('stricter() never picks an unknown or looser mode', () => {
    expect(stricter('workspace-write', 'read-only')).toBe('read-only')
    expect(stricter('read-only', 'workspace-write')).toBe('read-only')
    expect(stricter('danger-full-access', 'workspace-write')).toBe('workspace-write')
    expect(stricter('weird', 'workspace-write')).toBe('workspace-write')
  })

  it('read guard allows exactly the read-only tool set', () => {
    for (const t of ['read', 'glob', 'grep', 'skill', 'read_image', 'todo_write', 'web_search', 'web_fetch', 'ask_user_question', 'present']) expect(readToolGuard({ name: t })).toBeUndefined()
    for (const t of ['bash', 'write', 'edit', 'browser_act', 'triggers_save', 'subagent']) expect(readToolGuard({ name: t })).toMatch(/not available/)
  })
})
