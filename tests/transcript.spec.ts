import { describe, expect, it } from 'vitest'
import { Transcript } from '../src/host/transcript.ts'

describe('transcript', () => {
  it('folds user, assistant and tool calls; skips runtime-context and duplicates', () => {
    const t = new Transcript()
    expect(t.foldEvent(1, 'user/message', { source: { kind: 'runtime-context' }, content: [{ type: 'text', text: 'ctx' }] })).toEqual([])
    const user = t.foldEvent(2, 'user/message', { content: [{ type: 'text', text: 'hi' }] })
    expect(user).toEqual([{ type: 'entry', entry: expect.objectContaining({ kind: 'user', text: 'hi' }) }])
    t.foldEvent(3, 'turn/start', {})
    const out = t.foldEvent(4, 'assistant/message', { message: { content: [{ type: 'reasoning', text: 'secret' }, { type: 'text', text: 'hello' }, { type: 'tool-call', name: 'bash', arguments: '{"command":"ls"}' }] } })
    const kinds = out.filter((u) => u.type === 'entry').map((u) => (u as { entry: { kind: string; text: string } }).entry)
    expect(kinds.map((e) => e.kind)).toEqual(['assistant', 'tool'])
    expect(kinds[0]?.text).toBe('hello')
    expect(kinds[1]?.text).toBe('ls')
    expect(t.foldEvent(4, 'assistant/message', { message: { content: [{ type: 'text', text: 'dup' }] } })).toEqual([])
    expect(t.running).toBe(true)
    t.foldEvent(5, 'turn/end', {})
    expect(t.running).toBe(false)
  })
  it('accumulates text deltas and ignores reasoning blocks', () => {
    const t = new Transcript()
    t.foldStream({ type: 'start' })
    t.foldStream({ type: 'chunk', chunk: { type: 'block-start', index: 0, blockType: 'reasoning' } })
    expect(t.foldStream({ type: 'chunk', chunk: { type: 'text-delta', index: 1, text: 'Hel' } })).toBe('Hel')
    expect(t.foldStream({ type: 'chunk', chunk: { type: 'text-delta', index: 1, text: 'lo' } })).toBe('Hello')
  })
})
