// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest'
import { BURST_MS, REUSE_MS, loadProposals, resetProposalsCache } from '../src/client/proposals-cache.ts'
import type { ProposalsResult } from '../src/client/api.ts'

const result = (pending: number): ProposalsResult => ({ proposals: [], pending, target: 'x' })
afterEach(() => { resetProposalsCache() })

describe('shared proposals read', () => {
  it('turns a hundred approval cards into one request', async () => {
    let calls = 0
    const fetcher = async (): Promise<ProposalsResult> => { calls++; return result(calls) }
    const all = await Promise.all(Array.from({ length: 105 }, () => loadProposals({ fetcher, now: () => 1000 })))
    expect(calls).toBe(1)
    expect(new Set(all).size).toBe(1)
  })

  it('reuses an answer inside the reuse window and asks again after it', async () => {
    let calls = 0
    const fetcher = async (): Promise<ProposalsResult> => result(++calls)
    await loadProposals({ fetcher, now: () => 0 })
    await loadProposals({ fetcher, now: () => REUSE_MS - 1 })
    expect(calls).toBe(1)
    await loadProposals({ fetcher, now: () => REUSE_MS + 1 })
    expect(calls).toBe(2)
  })

  it('a push notification skips the reuse window but coalesces its own burst', async () => {
    let calls = 0
    const fetcher = async (): Promise<ProposalsResult> => result(++calls)
    await loadProposals({ fetcher, now: () => 0 })
    await Promise.all(Array.from({ length: 50 }, () => loadProposals({ fetcher, fresh: true, now: () => BURST_MS + 10 })))
    expect(calls).toBe(2)
  })

  it('never reuses a failed read', async () => {
    let calls = 0
    const failing = async (): Promise<ProposalsResult> => { calls++; throw new Error('down') }
    await expect(loadProposals({ fetcher: failing, now: () => 0 })).rejects.toThrow('down')
    await Promise.resolve()
    await expect(loadProposals({ fetcher: failing, now: () => 1 })).rejects.toThrow('down')
    expect(calls).toBe(2)
  })
})
