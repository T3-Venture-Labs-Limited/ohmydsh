import { describe, expect, it } from 'vitest'
import { createCommentStore } from '../src/client/store.ts'
import { sendToComposer } from '../src/client/send.ts'
import type { NewComment } from '../src/client/types.ts'

const store = () => createCommentStore({ getItem: () => null, setItem: () => {}, removeItem: () => {} })
const d = (body: string): NewComment => ({ sessionId: 's', target: { kind: 'message', role: 'assistant' }, anchor: { kind: 'message', nodeKey: 'k' }, quote: 'quoted', find: 'q', prefix: '', suffix: '', occurrence: 0, body })

describe('sendToComposer', () => {
  it('inserts one chip per comment and marks them sent', () => {
    const s = store(); s.add(d('one')); s.add(d('two'))
    const calls: { text: string; label: string }[] = []
    const r = sendToComposer(s, 's', { insertQuote: (text, summary) => { calls.push({ text, label: summary!.label }); return true } }, s.list('s'))
    expect(r).toEqual({ inserted: 2, blocked: false })
    expect(calls).toHaveLength(2)
    expect(calls[0]!.text).toContain('Comment: one')
    expect(s.list('s').every(c => c.status === 'sent')).toBe(true)
  })
  it('stops at the first refusal and keeps the rest open', () => {
    const s = store(); s.add(d('one')); s.add(d('two')); s.add(d('three'))
    let n = 0
    const r = sendToComposer(s, 's', { insertQuote: () => (++n <= 1) }, s.list('s'))
    expect(r).toEqual({ inserted: 1, blocked: true })
    expect(s.list('s').map(c => c.status)).toEqual(['sent', 'open', 'open'])
  })
  it('treats a throwing composer as blocked', () => {
    const s = store(); s.add(d('one'))
    const r = sendToComposer(s, 's', { insertQuote: () => { throw new Error('gone') } }, s.list('s'))
    expect(r.blocked).toBe(true)
  })
})
