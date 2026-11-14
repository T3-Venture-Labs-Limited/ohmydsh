/**
 * Realtime events: Pusher chunk reassembly, V1/V2/V3 normalisation and the channel auth shape.
 *
 * Spike findings (2026-11-13, verified against the live service):
 *  - channel: `private-cli-<project_id>` (the SDK's `private-<project>_triggers` is rejected for the CLI user key).
 *  - event name: `chunked-trigger_to_client`, envelope `{id, index, chunk, final}`; the joined chunks are the JSON event.
 *  - POST /api/v3.1/cli/realtime/auth answers `{auth, channel_data}`. For this PRIVATE (non-presence) channel the client
 *    MUST hand pusher-js only `{auth}`: passing `channel_data` as well makes Pusher recompute the signature over
 *    `socket_id:channel:channel_data` and reject it ("Invalid signature"), so the subscription never succeeds.
 */
export const CHANNEL_PREFIX = 'private-cli-'
export const EVENT_NAMES = ['chunked-trigger_to_client', 'trigger_to_client'] as const
export const MAX_PENDING_CHUNK_IDS = 100
export const MAX_CHUNK_INDEX = 1000
const MAX_EVENT_CHARS = 2_000_000

/** Reduce the auth endpoint's response to what a private channel may carry. */
export function privateChannelAuth(response: unknown): { auth: string } {
  const auth = (response as { auth?: unknown } | null)?.auth
  if (typeof auth !== 'string' || auth === '') throw new Error('realtime auth response has no `auth`')
  return { auth }
}

export interface NormalizedEvent {
  eventId: string; triggerId: string; triggerSlug: string; toolkit: string; connectedAccountId: string; userId: string
  timestamp: string; version: 'V1' | 'V2' | 'V3'; data: Record<string, unknown>
}

const rec = (v: unknown): Record<string, unknown> => (typeof v === 'object' && v !== null && !Array.isArray(v) ? v as Record<string, unknown> : {})
const s = (v: unknown): string => (typeof v === 'string' ? v : '')

/** V3: {id,type,timestamp,metadata,data}. V2: {type,timestamp,log_id,data}. Else V1 (flat `{trigger_name, ...}` shapes). */
export function normalizeEvent(raw: unknown): NormalizedEvent | undefined {
  const o = rec(raw)
  const data = rec(o['data'])
  if (typeof o['id'] === 'string' && typeof o['type'] === 'string' && typeof o['timestamp'] === 'string' && typeof o['metadata'] === 'object') {
    const m = rec(o['metadata'])
    if (s(o['type']) !== 'composio.trigger.message') return undefined // other project events (e.g. account expiry) are not trigger runs
    return { eventId: s(o['id']), triggerId: s(m['trigger_id']), triggerSlug: s(m['trigger_slug']), toolkit: s(m['toolkit_slug']) || s(m['trigger_slug']).split('_')[0]?.toLowerCase() || '', connectedAccountId: s(m['connected_account_id']), userId: s(m['user_id']), timestamp: s(o['timestamp']), version: 'V3', data }
  }
  if (typeof o['type'] === 'string' && typeof o['timestamp'] === 'string' && typeof o['log_id'] === 'string') {
    const m = rec(o['metadata'])
    return { eventId: s(o['log_id']), triggerId: s(m['trigger_id']) || s(data['trigger_id']), triggerSlug: s(m['trigger_slug']) || s(o['type']), toolkit: '', connectedAccountId: s(m['connected_account_id']), userId: s(m['user_id']), timestamp: s(o['timestamp']), version: 'V2', data }
  }
  const slug = s(o['triggerName']) || s(o['trigger_name'])
  if (slug === '') return undefined
  return { eventId: s(o['metadata_id']) || s(o['id']) || `${slug}:${s(o['timestamp'])}`, triggerId: s(o['triggerId']) || s(o['trigger_id']), triggerSlug: slug, toolkit: '', connectedAccountId: s(o['connectionId']) || s(o['connected_account_id']), userId: s(o['clientId']), timestamp: s(o['timestamp']), version: 'V1', data: rec(o['payload']) }
}

interface Pending { chunks: Map<number, string>; final: number | undefined; at: number }

/** Reassembles `{id,index,chunk,final}` envelopes. Bounded: at most 100 pending ids, chunk index <= 1000, stale ids dropped. */
export class ChunkAssembler {
  private readonly pending = new Map<string, Pending>()
  constructor(private readonly now: () => number = Date.now, private readonly staleMs = 60_000) {}

  /** Feed one Pusher event payload; returns the finished JSON value when the message is complete. */
  push(payload: unknown): unknown | undefined {
    const o = rec(payload)
    if (typeof o['chunk'] !== 'string' || typeof o['id'] !== 'string') return undefined
    const index = typeof o['index'] === 'number' ? o['index'] : 0
    if (!Number.isInteger(index) || index < 0 || index > MAX_CHUNK_INDEX) return undefined
    const t = this.now()
    for (const [id, p] of this.pending) if (t - p.at > this.staleMs) this.pending.delete(id)
    let entry = this.pending.get(o['id'])
    if (entry === undefined) {
      if (this.pending.size >= MAX_PENDING_CHUNK_IDS) { const oldest = this.pending.keys().next().value; if (oldest !== undefined) this.pending.delete(oldest) }
      entry = { chunks: new Map(), final: undefined, at: t }
      this.pending.set(o['id'], entry)
    }
    entry.chunks.set(index, o['chunk'])
    if (o['final'] === true) entry.final = index
    if (entry.final === undefined) return undefined
    for (let i = 0; i <= entry.final; i++) if (!entry.chunks.has(i)) return undefined
    this.pending.delete(o['id'])
    const text = Array.from({ length: entry.final + 1 }, (_, i) => entry?.chunks.get(i) ?? '').join('')
    if (text.length > MAX_EVENT_CHARS) return undefined
    try { return JSON.parse(text) as unknown } catch { return undefined }
  }
  get size(): number { return this.pending.size }
}

/** Decode one Pusher event (chunked or plain) into a normalised event. */
export function decodePusherEvent(assembler: ChunkAssembler, eventName: string, data: unknown): NormalizedEvent | undefined {
  let payload: unknown = data
  if (typeof data === 'string') { try { payload = JSON.parse(data) } catch { return undefined } }
  if (eventName.startsWith('chunked-')) { const joined = assembler.push(payload); return joined === undefined ? undefined : normalizeEvent(joined) }
  if (!(EVENT_NAMES as readonly string[]).includes(eventName)) return undefined
  return normalizeEvent(payload)
}
