// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { AutomationModelsCore, BUILTIN_DEFAULT, scheduleKeys, type AgentLike, type MarkerRecord, type OverrideRecord, type Route, type StoreFace } from '../src/host/core.ts'

class MemStore implements StoreFace {
  on = true
  defaults = new Map<string, { route: Route | null }>()
  overrides = new Map<string, OverrideRecord>()
  markers = new Map<string, MarkerRecord>()
  enabled() { return this.on }
  getDefault(kind: string) { return this.defaults.get(kind) }
  getOverride(kind: string, key: string) { return this.overrides.get(`${kind}:${key}`) }
  getMarker(id: string) { return this.markers.get(id) }
  putMarker(id: string, m: MarkerRecord) { this.markers.set(id, m) }
  deleteMarker(id: string) { this.markers.delete(id) }
}

const haiku: Route = { provider: 'claude', model: 'claude-haiku-5-5', reasoningEffort: 'low' }
const opus: Route = { provider: 'claude', model: 'claude-opus-5-5', reasoningEffort: 'xhigh' }

function makeAgent(initial: Route | undefined, id = 'a1'): AgentLike & { selections: Route[] } {
  let current = initial
  const selections: Route[] = []
  return {
    id, selections,
    model: { current: () => (current === undefined ? undefined : { ...current }), select: (r) => { current = { ...r }; selections.push({ ...r }) } },
  }
}
const msg = (kind: string, text = '') => ({ source: { kind }, content: [{ type: 'text', text }] })
const reminder = (id: string) => msg('schedule', `[SCHEDULE REMINDER]\nThis is a scheduled message from the user\nschedule_id_json: ${JSON.stringify(id)}\noccurrence_at: x\nreminder_prompt_json: "hi"`)
const batch = (ids: string[]) => msg('schedule', `[SCHEDULE REMINDER BATCH]\nThis is a scheduled message from the user\nreminders_json: ${JSON.stringify(ids.map((i) => ({ schedule_id: i, occurrence_at: 'x', reminder_prompt: 'p' })))}`)
const change = (id: string) => msg('schedule', `[SCHEDULE CHANGE]\nA scheduled task ... \nschedule_id_json: ${JSON.stringify(id)}`)

function setup(avail: (r: Route) => boolean | undefined = () => true) {
  const store = new MemStore()
  const logs: string[] = []
  const core = new AutomationModelsCore({ store, available: avail, log: { info: (m) => logs.push(m), warn: (m) => logs.push(`WARN ${m}`) } })
  return { store, core, logs }
}

describe('schedule key parsing', () => {
  it('reads single and batch ids, ignores change notices', () => {
    expect(scheduleKeys(reminder('sch-1'))).toEqual(['sch-1'])
    expect(scheduleKeys(batch(['a', 'b']))).toEqual(['a', 'b'])
    expect(scheduleKeys(change('x'))).toBeUndefined()
    expect(scheduleKeys(msg('schedule', 'garbage'))).toBeUndefined()
  })
})

describe('resolution order', () => {
  it('falls back to the built-in default (claude-sonnet-5-5, low)', () => {
    const { core } = setup()
    expect(BUILTIN_DEFAULT).toMatchObject({ provider: 'claude', model: 'claude-sonnet-5-5', reasoningEffort: 'low' })
    expect(core.resolveFor(reminder('t'))).toMatchObject({ route: BUILTIN_DEFAULT, via: 'builtin' })
  })
  it('override > stored default > registered default > builtin', () => {
    const { core, store } = setup()
    core.registerSource('composio', { label: 'Composio', defaultRoute: haiku })
    expect(core.resolveFor(msg('composio'))).toMatchObject({ route: haiku, via: 'source-default' })
    store.defaults.set('composio', { route: opus })
    expect(core.resolveFor(msg('composio'))).toMatchObject({ route: opus, via: 'default' })
    store.overrides.set('schedule:t', { route: haiku })
    expect(core.resolveFor(reminder('t'))).toMatchObject({ route: haiku, via: 'override' })
  })
  it('returns undefined for non-sources, change notices, and explicit session-model choices', () => {
    const { core, store } = setup()
    expect(core.resolveFor(msg('user'))).toBeUndefined()
    expect(core.resolveFor(change('t'))).toBeUndefined()
    store.overrides.set('schedule:t', { route: null })
    expect(core.resolveFor(reminder('t'))).toBeUndefined()
    store.defaults.set('sentinel', { route: null })
    expect(core.resolveFor(msg('sentinel'))).toBeUndefined()
  })
  it('resolveKind serves non-message sources such as the skill reviewer (used by service.resolve)', () => {
    const { core, store } = setup()
    core.registerSource('skill-reviewer', { label: 'Skill reviewer', defaultRoute: haiku })
    const source = core.getSource('skill-reviewer')!
    expect(core.resolveKind(source, undefined)?.route).toEqual(haiku)
    store.defaults.set('skill-reviewer', { route: opus })
    expect(core.resolveKind(source, undefined)?.route).toEqual(opus)
    store.defaults.set('skill-reviewer', { route: null })
    expect(core.resolveKind(source, undefined)).toBeUndefined()
    expect(core.getSource('nope')).toBeUndefined()
  })
  it('batch reminders: the first task wins', () => {
    const { core, store } = setup()
    store.overrides.set('schedule:b', { route: haiku })
    store.overrides.set('schedule:a', { route: opus })
    expect(core.resolveFor(batch(['a', 'b']))?.route).toEqual(opus)
    expect(core.resolveFor(batch(['b', 'a']))?.route).toEqual(haiku)
  })
  it('unavailable override falls back to the source default, then builtin', () => {
    const bad: Route = { provider: 'x', model: 'gone' }
    const { core, store } = setup((r) => r.provider !== 'x')
    store.overrides.set('schedule:t', { route: bad })
    store.defaults.set('schedule', { route: haiku })
    const r = core.resolveFor(reminder('t'))
    expect(r).toMatchObject({ route: haiku, via: 'default' })
    expect(r?.skipped).toEqual(['x/gone'])
    store.defaults.set('schedule', { route: bad })
    expect(core.resolveFor(reminder('t'))).toMatchObject({ route: BUILTIN_DEFAULT, via: 'builtin' })
  })
  it('registerSource validates kinds and disposes cleanly', () => {
    const { core } = setup()
    expect(() => core.registerSource('user', { label: 'x' })).toThrow()
    const dispose = core.registerSource('skill-reviewer', { label: 'Skill reviewer' })
    expect(core.getSource('skill-reviewer')).toBeDefined()
    dispose()
    expect(core.getSource('skill-reviewer')).toBeUndefined()
    // a builtin survives its replacement being disposed
    const d2 = core.registerSource('schedule', { label: 'Mine' })
    d2()
    expect(core.getSource('schedule')?.label).toBe('Scheduled tasks')
  })
})

describe('temporary switch', () => {
  it('switches on claimed, restores on idle, writes and clears the crash marker', () => {
    const { core, store } = setup()
    const agent = makeAgent(haiku)
    core.onClaimed(agent, reminder('t'))
    expect(agent.model.current()).toMatchObject({ model: 'claude-sonnet-5-5', reasoningEffort: 'low' })
    expect(store.markers.get('a1')).toMatchObject({ previous: haiku })
    core.onStatus(agent, 'running')
    expect(agent.model.current()?.model).toBe('claude-sonnet-5-5')
    core.onStatus(agent, 'idle')
    expect(agent.model.current()).toEqual(haiku)
    expect(store.markers.size).toBe(0)
  })
  it('does not restore over a model the user picked in the meantime', () => {
    const { core } = setup()
    const agent = makeAgent(haiku)
    core.onClaimed(agent, reminder('t'))
    agent.model.select(opus)
    core.onStatus(agent, 'idle')
    expect(agent.model.current()).toEqual(opus)
  })
  it('switches once per turn and leaves ordinary messages, disabled state and subagents alone', () => {
    const { core, store } = setup()
    const agent = makeAgent(haiku)
    core.onClaimed(agent, msg('user'))
    expect(agent.selections).toHaveLength(0)
    store.on = false
    core.onClaimed(agent, reminder('t'))
    expect(agent.selections).toHaveLength(0)
    store.on = true
    core.onClaimed(agent, reminder('t'))
    core.onClaimed(agent, reminder('t'))
    expect(agent.selections).toHaveLength(1)
    const sub = { ...makeAgent(haiku, 'sub'), session: { header: { origin: 'subagent' } } }
    core.onClaimed(sub, reminder('t'))
    expect(sub.selections).toHaveLength(0)
  })
  it('is a no-op when the session already runs the target route, and when it has no route', () => {
    const { core } = setup()
    const same = makeAgent(BUILTIN_DEFAULT)
    core.onClaimed(same, reminder('t'))
    expect(same.selections).toHaveLength(0)
    const none = makeAgent(undefined)
    core.onClaimed(none, reminder('t'))
    expect(none.selections).toHaveLength(0)
  })
  it('keep-after-run overrides are not restored', () => {
    const { core, store } = setup()
    store.overrides.set('schedule:t', { route: opus, keep: true })
    const agent = makeAgent(haiku)
    core.onClaimed(agent, reminder('t'))
    core.onStatus(agent, 'idle')
    expect(agent.model.current()).toMatchObject({ model: 'claude-opus-5-5' })
    expect(store.markers.size).toBe(0)
  })
  it('never throws out of the listener (fails open)', () => {
    const { core, logs } = setup()
    const agent = makeAgent(haiku)
    agent.model.select = () => { throw new Error('boom') }
    expect(() => { core.onClaimed(agent, reminder('t')) }).not.toThrow()
    expect(logs.some((l) => l.includes('boom'))).toBe(true)
  })
  it('restores a stale marker when a crashed session is resumed', () => {
    const { core, store } = setup()
    store.markers.set('a1', { previous: haiku, applied: BUILTIN_DEFAULT, at: 1 })
    const agent = makeAgent(BUILTIN_DEFAULT)
    core.onCreated(agent, 'startup')
    expect(agent.selections).toHaveLength(0)
    store.markers.set('a1', { previous: haiku, applied: BUILTIN_DEFAULT, at: 1 })
    core.onCreated(agent, 'resume')
    expect(agent.model.current()).toEqual(haiku)
  })
  it('applyTo is the reusable primitive for other plugins', () => {
    const { core } = setup()
    const agent = makeAgent(haiku)
    expect(core.applyTo(agent, opus)).toBe(true)
    core.onStatus(agent, 'idle')
    expect(agent.model.current()).toEqual(haiku)
  })
})
