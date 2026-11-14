import { describe, expect, it } from 'vitest'
import { capQuote, chipSummary, chipText, groupComments, labelOf, locationOf } from '../src/client/format.ts'
import type { ReviewComment } from '../src/client/types.ts'

const base = (over: Partial<ReviewComment>): ReviewComment => ({
  id: 'a', number: 1, sessionId: 's', quote: 'The system shall respond within 5 seconds.', find: '', prefix: '', suffix: '', occurrence: 0,
  body: 'make this 2 seconds', status: 'open', createdAt: 0, updatedAt: 0,
  target: { kind: 'file', path: 'docs/spec.docx', address: 'dsh-resource://file/session/s/docs/spec.docx', renderer: 'office', format: 'docx' },
  anchor: { kind: 'pdf', page: 3, pageEnd: 3, rects: [] }, ...over,
})

describe('chip format', () => {
  it('carries file, location, quote and comment in one text', () => {
    const t = chipText(base({}))
    expect(t).toContain('Review comment RC-1')
    expect(t).toContain('File: docs/spec.docx')
    expect(t).toContain('Location: page 3')
    expect(t).toContain('The system shall respond within 5 seconds.')
    expect(t).toContain('Comment: make this 2 seconds')
  })
  it('labels pptx pages as slides', () => {
    const c = base({ target: { kind: 'file', path: 'd.pptx', address: 'x', renderer: 'office', format: 'pptx' } })
    expect(locationOf(c)).toBe('slide 3')
    expect(labelOf(c)).toBe('RC-1 d.pptx s.3')
  })
  it('formats line anchors, exact and approximate', () => {
    const t = { kind: 'file', path: 'src/a.ts', address: 'x', renderer: 'bs-code', format: 'code' } as const
    expect(locationOf(base({ target: t, anchor: { kind: 'lines', start: 41, end: 47, hint: 'exact' } }))).toBe('lines 41–47')
    expect(locationOf(base({ target: t, anchor: { kind: 'lines', start: 4, end: 4, hint: 'searched' } }))).toBe('line 4 (approx.)')
    expect(locationOf(base({ target: t, anchor: { kind: 'lines', start: 0, end: 0, hint: 'none' } }))).toBe('rendered text')
  })
  it('uses a longer fence when the quote contains backticks', () => {
    expect(chipText(base({ quote: 'a ```ts\nb\n``` c' }))).toContain('````')
  })
  it('caps very long quotes but says so', () => {
    const q = capQuote('x'.repeat(5000))
    expect(q.length).toBeLessThan(1600)
    expect(q).toContain('truncated, 5000 chars')
  })
  it('summary shows body when present, else the quote', () => {
    expect(chipSummary(base({})).body).toBe('make this 2 seconds')
    expect(chipSummary(base({ body: '' })).body).toContain('The system shall')
    expect(chipSummary(base({})).label).toBe('RC-1 spec.docx p.3')
  })
  it('groups by file and orders by position', () => {
    const a = base({ id: '1', number: 1, anchor: { kind: 'pdf', page: 5, pageEnd: 5, rects: [] } })
    const b = base({ id: '2', number: 2, anchor: { kind: 'pdf', page: 2, pageEnd: 2, rects: [] } })
    const chat = base({ id: '3', number: 3, target: { kind: 'message', role: 'assistant' }, anchor: { kind: 'message', nodeKey: 'k' } })
    const groups = groupComments([a, chat, b])
    expect(groups.map(g => g.key)).toEqual([`file:${(a.target as { address: string }).address}`, 'chat'])
    expect(groups[0]!.items.map(i => i.id)).toEqual(['2', '1'])
  })
})
