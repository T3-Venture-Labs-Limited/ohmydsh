import { describe, expect, it } from 'vitest'
import { emptySnapshot, mergeSnapshots, normalizeSnapshot, sameSnapshot } from '../src/shared/merge.ts'
import type { ReviewComment } from '../src/client/types.ts'

const c = (over: Partial<ReviewComment>): ReviewComment => ({
  id: 'a', number: 1, sessionId: 's', target: { kind: 'message', role: 'assistant' }, anchor: { kind: 'message', nodeKey: 'k' },
  quote: 'q', find: 'q', prefix: '', suffix: '', occurrence: 0, body: 'b', status: 'open', createdAt: 1, updatedAt: 1, ...over,
})

describe('snapshot merge', () => {
  it('keeps the newer edit per id', () => {
    const a = { ...emptySnapshot(), items: [c({ body: 'old', updatedAt: 1 })], next: 2 }
    const b = { ...emptySnapshot(), items: [c({ body: 'new', updatedAt: 5, status: 'resolved', resolvedBy: 'agent' as const })], next: 2 }
    const m = mergeSnapshots(a, b)
    expect(m.items).toHaveLength(1)
    expect(m.items[0]).toMatchObject({ body: 'new', status: 'resolved', resolvedBy: 'agent' })
  })
  it('unions comments created on either side and keeps the counter ahead', () => {
    const a = { ...emptySnapshot(), items: [c({ id: 'a', number: 1 })], next: 2 }
    const b = { ...emptySnapshot(), items: [c({ id: 'b', number: 2 })], next: 3 }
    const m = mergeSnapshots(a, b)
    expect(m.items.map(i => i.id)).toEqual(['a', 'b'])
    expect(m.next).toBe(3)
  })
  it('a tombstone beats a stale copy on the other side', () => {
    const a = { ...emptySnapshot(), items: [], removed: ['a'], next: 2 }
    const b = { ...emptySnapshot(), items: [c({ id: 'a' })], next: 2 }
    expect(mergeSnapshots(a, b).items).toEqual([])
    expect(mergeSnapshots(b, a).items).toEqual([])
  })
  it('is idempotent and commutative on equal data', () => {
    const a = { ...emptySnapshot(), items: [c({ id: 'a' }), c({ id: 'b', number: 2 })], next: 3 }
    const b = { ...emptySnapshot(), items: [c({ id: 'b', number: 2, updatedAt: 9 })], next: 3 }
    expect(sameSnapshot(mergeSnapshots(a, b), mergeSnapshots(b, a))).toBe(true)
    const m = mergeSnapshots(a, b)
    expect(sameSnapshot(mergeSnapshots(m, m), m)).toBe(true)
  })
  it('normalizes untrusted input', () => {
    const n = normalizeSnapshot({ next: 'x', items: [c({}), { id: 5 }, null, c({ id: 'z', status: 'weird' as never })], removed: [1, 'r'] })
    expect(n.items.map(i => i.id)).toEqual(['a'])
    expect(n.removed).toEqual(['r'])
    expect(n.next).toBe(2)
  })
})
