import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { HostStore, TooLargeError } from '../src/host/store.ts'
import { createReviewTool, rowOf } from '../src/host/tool.ts'
import type { ReviewComment } from '../src/client/types.ts'

let dir = ''
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'drc-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

const c = (n: number, over: Partial<ReviewComment> = {}): ReviewComment => ({
  id: `id${String(n)}`, number: n, sessionId: 's1', quote: `quote ${String(n)}`, find: 'q', prefix: '', suffix: '', occurrence: 0, body: `body ${String(n)}`,
  status: 'sent', createdAt: 1, updatedAt: 1,
  target: { kind: 'file', path: 'docs/spec.docx', address: 'a', renderer: 'office', format: 'docx' },
  anchor: { kind: 'pdf', page: 3, pageEnd: 3, rects: [] }, ...over,
})
const run = async (store: HostStore, args: Record<string, unknown>, id: string | null = 's1') => {
  const tool = createReviewTool(store)
  return await tool.execute(args as never, { agent: id === null ? undefined : { id } } as never) as unknown as { message: string; comments?: unknown[]; resolved?: number[]; missing?: number[]; counts?: Record<string, number> }
}

describe('host store', () => {
  it('persists merged browser snapshots and reloads them', async () => {
    const a = new HostStore(dir)
    await a.merge('s1', { next: 3, items: [c(1), c(2)], removed: [] })
    const b = new HostStore(dir)
    expect((await b.get('s1')).items.map(i => i.number)).toEqual([1, 2])
    expect(JSON.parse(await readFile(join(dir, 's1.json'), 'utf8')).next).toBe(3)
  })
  it('rejects unsafe session ids', async () => {
    await expect(new HostStore(dir).get('../etc/passwd')).rejects.toThrow('invalid session id')
  })
  it('notifies subscribers only on real change', async () => {
    const s = new HostStore(dir); const seen: string[] = []
    s.subscribe(id => seen.push(id))
    await s.merge('s1', { next: 2, items: [c(1)], removed: [] })
    await s.merge('s1', { next: 2, items: [c(1)], removed: [] })
    expect(seen).toEqual(['s1'])
  })
  it('survives a corrupt file', async () => {
    const { writeFile } = await import('node:fs/promises')
    await writeFile(join(dir, 's9.json'), '{nope')
    expect((await new HostStore(dir).get('s9')).items).toEqual([])
  })
})

describe('review_comments tool', () => {
  it('lists unresolved comments with bounded rows', async () => {
    const s = new HostStore(dir)
    await s.merge('s1', { next: 4, items: [c(1, { quote: 'x'.repeat(900) }), c(2, { status: 'resolved', resolvedBy: 'user' }), c(3, { status: 'open' })], removed: [] })
    const r = await run(s, { action: 'list' })
    expect(r.comments).toHaveLength(2)
    expect(r.counts).toEqual({ open: 1, sent: 1, resolved: 1 })
    expect((r.comments![0] as { quote_untrusted: string }).quote_untrusted.length).toBeLessThan(450)
    expect(r.message).toContain('2 unresolved')
  })
  it('filters by status and reports an empty set', async () => {
    const s = new HostStore(dir)
    expect((await run(s, { action: 'list', status: 'resolved' })).message).toContain('No resolved')
  })
  it('resolves by RC number and records who and why', async () => {
    const s = new HostStore(dir)
    await s.merge('s1', { next: 3, items: [c(1), c(2, { status: 'open' })], removed: [] })
    const seen: string[] = []; s.subscribe(id => seen.push(id))
    const r = await run(s, { action: 'resolve', numbers: [1, 9], note: 'Rewrote the clause to 2 seconds.' })
    expect(r.resolved).toEqual([1]); expect(r.missing).toEqual([9])
    const snap = await s.get('s1')
    expect(snap.items[0]).toMatchObject({ status: 'resolved', resolvedBy: 'agent', resolution: 'Rewrote the clause to 2 seconds.' })
    expect(snap.items[0]!.updatedAt).toBeGreaterThan(1)
    expect(snap.items[1]!.status).toBe('open')
    expect(seen).toEqual(['s1'])
    expect(rowOf(snap.items[0]!).status).toBe('resolved by agent')
  })
  it('does not resolve twice and asks for numbers', async () => {
    const s = new HostStore(dir)
    await s.merge('s1', { next: 2, items: [c(1)], removed: [] })
    await run(s, { action: 'resolve', numbers: [1] })
    expect((await run(s, { action: 'resolve', numbers: [1] })).message).toContain('Already resolved: RC-1')
    expect((await run(s, { action: 'resolve' })).message).toContain('Pass numbers')
  })
  it('without an agent there is nothing to act on', async () => {
    expect((await run(new HostStore(dir), { action: 'list' }, null)).message).toContain('No session')
  })
  it('only touches the calling session', async () => {
    const s = new HostStore(dir)
    await s.merge('s1', { next: 2, items: [c(1)], removed: [] })
    await s.merge('s2', { next: 2, items: [c(1, { id: 'other' })], removed: [] })
    await run(s, { action: 'resolve', numbers: [1] }, 's2')
    expect((await s.get('s1')).items[0]!.status).toBe('sent')
    expect((await s.get('s2')).items[0]!.status).toBe('resolved')
  })
})

describe('session file byte cap', () => {
  const big = (n: number, size: number): ReviewComment => c(n, { quote: 'x'.repeat(size) })
  it('refuses a merge that would grow past the cap and keeps the old file', async () => {
    const s = new HostStore(dir, Date.now, 4000)
    await s.merge('s1', { next: 2, items: [big(1, 1000)], removed: [] })
    await expect(s.merge('s1', { next: 5, items: [big(1, 1000), big(2, 1500), big(3, 1500)], removed: [] })).rejects.toBeInstanceOf(TooLargeError)
    expect((await s.get('s1')).items).toHaveLength(1)
  })
  it('always accepts a change that shrinks the file, even over the cap', async () => {
    const s = new HostStore(dir, Date.now, 4000)
    await s.merge('s1', { next: 3, items: [big(1, 1500), big(2, 1500)], removed: [] })
    const tight = new HostStore(dir, Date.now, 1200)
    expect((await tight.get('s1')).items).toHaveLength(2)
    await tight.merge('s1', { next: 3, items: [], removed: ['id1'] })
    expect((await tight.get('s1')).items.map(i => i.number)).toEqual([2])
  })
})
