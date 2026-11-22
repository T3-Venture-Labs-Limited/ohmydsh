// One proposals read shared by every approval card in a transcript. A long conversation mounts one TurnCards per completed turn, and
// each used to POST /api/skill-studio/proposals on its own (a hundred identical requests when a big session opened). Reads now share one
// in-flight request, reuse a fresh answer for a few seconds, and coalesce the burst a push notification causes.
import { call, type ProposalsResult } from './api.ts'

export const REUSE_MS = 4000
export const BURST_MS = 250

interface Entry { promise: Promise<ProposalsResult>; startedAt: number }
let current: Entry | undefined

/** Read the proposals. `fresh` is for a push notification or a decision: it skips the reuse window but still joins a request that just started. */
export function loadProposals(options: { fresh?: boolean; now?: () => number; fetcher?: () => Promise<ProposalsResult> } = {}): Promise<ProposalsResult> {
  const now = (options.now ?? Date.now)()
  const window = options.fresh === true ? BURST_MS : REUSE_MS
  if (current !== undefined && now - current.startedAt < window) return current.promise
  const fetcher = options.fetcher ?? (() => call<ProposalsResult>('proposals'))
  const entry: Entry = { startedAt: now, promise: fetcher() }
  current = entry
  // A failed read is never reused: the next card or notification asks again.
  entry.promise.catch(() => { if (current === entry) current = undefined })
  return entry.promise
}

/** Forget the shared answer (tests, and after the page decides a proposal). */
export function resetProposalsCache(): void { current = undefined }
