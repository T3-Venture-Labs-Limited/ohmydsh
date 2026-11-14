// One shared push channel carrying the pending count and the sessions that have proposals. It is a Typert stream on DSH's
// single multiplexed WebSocket (never an HTTP stream, which would hold one of the browser's 6 connections per host), it is
// open only while at least one subscriber (badge, card, page) is mounted AND the page is visible, and while it cannot be
// opened a slow (>= 15 s) poll of the proposals route keeps the badge fresh.
import { useEffect, useState } from 'react'
import { subscribePush } from '../kit/push/client.ts'
import type { PushEnv } from '../kit/push/client.ts'
import type { Summary } from './api.ts'

type Listener = (s: Summary) => void
export const STREAM_ID = 'dsh-skill-studio:summary'
export const FALLBACK_POLL_MS = 15_000
const EMPTY: Summary = { pending: 0, sessions: [], reviewing: false }

let last: Summary = EMPTY
let openStream: ((signal: AbortSignal) => AsyncIterable<unknown>) | undefined
let env: PushEnv = {}
const listeners = new Set<Listener>()

/** Wire the stream opener (set once by the client entry, or by a test). */
export function configureSummary(open: ((signal: AbortSignal) => AsyncIterable<unknown>) | undefined, pushEnv: PushEnv = {}): void {
  openStream = open; env = pushEnv; last = EMPTY
}

function valid(value: unknown): value is Summary {
  const s = value as Partial<Summary> | null
  return s !== null && typeof s === 'object' && typeof s.pending === 'number' && Array.isArray(s.sessions)
}

async function pollSummary(): Promise<void> {
  const response = await fetch('api/skill-studio/proposals', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
  const json = await response.json() as { ok?: boolean; value?: { proposals?: { status?: string; origin?: { sessionId?: string } }[] } }
  const list = json.value?.proposals
  if (json.ok !== true || list === undefined) return
  push({ pending: list.filter((p) => p.status === 'pending').length, sessions: [...new Set(list.map((p) => p.origin?.sessionId).filter((id): id is string => id !== undefined))].slice(-60), reviewing: last.reviewing })
}

function push(next: Summary): void {
  last = next
  for (const l of listeners) l(last)
}

/** Subscribe to summary changes; the shared stream lives exactly as long as there is a subscriber and a visible page. */
export function subscribeSummary(listener: Listener): () => void {
  listeners.add(listener)
  listener(last)
  const open = openStream
  const off = open === undefined ? undefined : subscribePush<unknown>({
    id: STREAM_ID,
    open,
    poll: pollSummary,
    pollMs: FALLBACK_POLL_MS,
  }, (item) => { if (valid(item)) push(item) }, env)
  return () => { listeners.delete(listener); off?.() }
}

export function useSummary(): Summary {
  const [s, setS] = useState<Summary>(last)
  useEffect(() => subscribeSummary(setS), [])
  return s
}
