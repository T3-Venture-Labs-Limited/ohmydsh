import { describe, expect, it } from 'vitest'
import { createCommentStore, type StorageLike } from '../src/client/store.ts'
import type { NewComment } from '../src/client/types.ts'

const mem = (): StorageLike & { data: Map<string, string> } => {
  const data = new Map<string, string>()
  return { data, getItem: k => data.get(k) ?? null, setItem: (k, v) => { data.set(k, v) }, removeItem: k => { data.delete(k) } }
}
const draft = (over: Partial<NewComment> = {}): NewComment => ({
  sessionId: 's1', target: { kind: 'message', role: 'assistant' }, anchor: { kind: 'message', nodeKey: 'k' },
  quote: 'q', find: 'q', prefix: '', suffix: '', occurrence: 0, body: 'b', ...over,
})

describe('comment store', () => {
  it('numbers comments per session and persists', () => {
    const storage = mem()
    const a = createCommentStore(storage)
    expect(a.add(draft()).number).toBe(1)
    expect(a.add(draft()).number).toBe(2)
    expect(a.add(draft({ sessionId: 's2' })).number).toBe(1)
    const b = createCommentStore(storage)
    expect(b.list('s1').map(c => c.number)).toEqual([1, 2])
    expect(b.add(draft()).number).toBe(3)
  })
  it('never reuses a number after delete', () => {
    const s = createCommentStore(mem())
    const one = s.add(draft()); s.add(draft()); s.remove('s1', one.id)
    expect(s.add(draft()).number).toBe(3)
  })
  it('updates status/body and notifies', () => {
    const s = createCommentStore(mem())
    let calls = 0
    s.subscribe(() => { calls += 1 })
    const c = s.add(draft())
    s.update('s1', c.id, { body: 'new' }); s.setStatus('s1', [c.id], 'sent')
    expect(s.get('s1', c.id)).toMatchObject({ body: 'new', status: 'sent' })
    expect(calls).toBe(3)
  })
  it('falls back to memory when storage throws', () => {
    const bad: StorageLike = { getItem: () => null, setItem: () => { throw new Error('quota') }, removeItem: () => { throw new Error('x') } }
    const s = createCommentStore(bad)
    s.add(draft())
    expect(s.list('s1')).toHaveLength(1)
    expect(s.memoryOnly('s1')).toBe(true)
  })
  it('ignores corrupt storage', () => {
    const storage = mem(); storage.setItem('dsh-review-comments:v1:s1', '{not json')
    expect(createCommentStore(storage).list('s1')).toEqual([])
  })
})
