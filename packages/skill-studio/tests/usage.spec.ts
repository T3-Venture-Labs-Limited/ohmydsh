// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { UsageIndex, countSkillEvents } from '../src/host/usage.ts'

describe('usage', () => {
  it('counts skill tool calls and /name invocations, ignoring malformed events', () => {
    const m = countSkillEvents([
      { type: 'tool/call', time: 10, data: { name: 'skill', arguments: '{"name":"a"}' } },
      { type: 'tool/call', time: 20, data: { name: 'skill', arguments: '{"name":"a"}' } },
      { type: 'tool/call', time: 30, data: { name: 'bash', arguments: '{"name":"a"}' } },
      { type: 'tool/call', time: 40, data: { name: 'skill', arguments: 'not json' } },
      { type: 'user/message', time: 50, data: { source: { kind: 'skill-invocation', name: 'b' } } },
      { type: 'user/message', time: 60, data: { source: { kind: 'user' } } },
    ])
    expect(m.get('a')).toEqual({ count: 2, last: 20 })
    expect(m.get('b')).toEqual({ count: 1, last: 50 })
    expect(m.size).toBe(2)
  })
  it('aggregates across sessions, tolerates unreadable ones, and reports unavailable readers', async () => {
    const reader = {
      listSessions: async () => [{ header: { id: 's1' } }, { header: { id: 's2' } }, { header: { id: 's3' } }],
      readSession: async (id: never) => {
        if (String(id) === 's3') throw new Error('migrating')
        return { events: [{ type: 'tool/call', time: String(id) === 's1' ? 5 : 9, data: { name: 'skill', arguments: '{"name":"a"}' } }] }
      },
    }
    const idx = new UsageIndex()
    const r = await idx.get(reader as never)
    expect(r.stats.a).toEqual({ count: 2, lastUsed: 9, sessions: 2 })
    expect(r.sessionsScanned).toBe(2)
    expect((await new UsageIndex().get(undefined)).available).toBe(false)
  })
})
