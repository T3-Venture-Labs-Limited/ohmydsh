// @vitest-environment node
// The agent tools' outputs go through DSH's lossless-JSON output validation: `undefined` anywhere is rejected at
// runtime ("value is not lossless JSON"), which only showed up live. Validate against the real schema validator.
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import { TriggersEngine } from '../../src/host/engine.ts'
import { TriggersStore } from '../../src/host/store.ts'
import { lossless, triggerTools } from '../../src/host/tools.ts'
import { automation, log, tempDir } from './helpers.ts'

let dir: string; let cleanup: () => Promise<void>
beforeEach(async () => { ({ dir, cleanup } = await tempDir()) })
afterEach(async () => { await cleanup() })

/** Deep check: no undefined values, no functions, only JSON. */
function assertLossless(value: unknown, path = 'value'): void {
  if (value === undefined) throw new Error(`${path} is undefined`)
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return
  if (typeof value === 'number') { if (!Number.isFinite(value)) throw new Error(`${path} is not finite`); return }
  if (Array.isArray(value)) { value.forEach((v, i) => { assertLossless(v, `${path}[${String(i)}]`) }); return }
  if (typeof value === 'object') { for (const [k, v] of Object.entries(value)) assertLossless(v, `${path}.${k}`); return }
  throw new Error(`${path} has type ${typeof value}`)
}

async function setup() {
  const store = new TriggersStore(join(dir, 'triggers'))
  await store.load()
  const engine = new TriggersEngine({
    store, deliver: vi.fn(async () => ({ sessionId: 'session-1', model: 'p/m' })), origin: () => 'http://127.0.0.1:3080',
    hasAutomationModels: () => false, hasComposio: () => false, workspaces: () => [], defaultCwd: () => dir, log,
  })
  const tools = Object.fromEntries(triggerTools(engine).map((t) => [t.name, t])) as Record<string, { execute: (args: never, exec: never) => Promise<unknown>; output: { schema: unknown } }>
  return { store, engine, tools }
}

describe('agent tool outputs are lossless JSON', () => {
  it('lossless() drops undefined fields', () => {
    expect(lossless({ a: 1, b: undefined, c: { d: undefined, e: [1] } })).toEqual({ a: 1, c: { e: [1] } })
  })

  it('triggers_list with an automation that has optional fields unset', async () => {
    const { store, tools } = await setup()
    store.data.automations.push(automation({ description: '' }))
    const out = await tools['triggers_list']!.execute({} as never, {} as never)
    assertLossless(out)
    expect(validateJsonSchemaValue(tools['triggers_list']!.output.schema as never, out)).toEqual([])
  })

  it('triggers_save returns the saved automation without undefined fields and never the secret', async () => {
    const { tools } = await setup()
    const out = await tools['triggers_save']!.execute({
      name: 'CI failures', source: { kind: 'webhook', auth: 'token', events: [] },
      target: { mode: 'new', cwd: dir, model: null, sandbox: 'read-only', tools: 'read', title: 'CI: {{event.repo}}' },
      prompt: 'Summarise {{event_fenced}}',
    } as never, {} as never)
    assertLossless(out)
    expect(validateJsonSchemaValue(tools['triggers_save']!.output.schema as never, out)).toEqual([])
    expect(JSON.stringify(out)).not.toMatch(/whsec_/)
  })

  it('triggers_save with only id + a few fields is a partial update (prompt, target and source kept)', async () => {
    const { store, tools } = await setup()
    const a = automation({ name: 'CI failures', prompt: 'Keep me {{event_fenced}}' }); store.data.automations.push(a)
    const out = await tools['triggers_save']!.execute({ id: a.id, name: 'CI failures (dup)', enabled: false, target: { title: 'New title' } } as never, {} as never)
    assertLossless(out)
    const saved = store.get(a.id)!
    expect(saved).toMatchObject({ name: 'CI failures (dup)', enabled: false, prompt: 'Keep me {{event_fenced}}', source: a.source })
    expect(saved.target).toMatchObject({ ...a.target, title: 'New title' })
  })

  it('triggers_list includes the prompt so an agent can edit it; set_enabled and delete work', async () => {
    const { store, tools } = await setup()
    const a = automation({ prompt: 'P {{event_fenced}}' }); store.data.automations.push(a)
    const listed = await tools['triggers_list']!.execute({} as never, {} as never) as { automations: { prompt: string }[] }
    expect(listed.automations[0]!.prompt).toBe('P {{event_fenced}}')
    assertLossless(await tools['triggers_set_enabled']!.execute({ id: a.id, enabled: false } as never, {} as never))
    expect(store.get(a.id)!.enabled).toBe(false)
    assertLossless(await tools['triggers_delete']!.execute({ id: a.id } as never, {} as never))
    expect(store.get(a.id)).toBeUndefined()
  })

  it('triggers_test returns a lossless run row', async () => {
    const { store, tools } = await setup()
    const a = automation(); store.data.automations.push(a)
    const out = await tools['triggers_test']!.execute({ id: a.id, payload: { hello: 'world' } } as never, {} as never)
    assertLossless(out)
    expect(validateJsonSchemaValue(tools['triggers_test']!.output.schema as never, out)).toEqual([])
  })
})
