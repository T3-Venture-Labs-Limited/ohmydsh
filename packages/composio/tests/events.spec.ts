// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { ChunkAssembler, CHANNEL_PREFIX, EVENT_NAMES, decodePusherEvent, normalizeEvent, privateChannelAuth, MAX_PENDING_CHUNK_IDS } from '../src/host/events.ts'

// Shape captured from the live spike (GITHUB_ISSUE_ADDED_EVENT, 2026-11-13); content abridged and made up.
const v3 = {
  id: 'msg_1', timestamp: '2026-11-13T17:48:00.857Z', type: 'composio.trigger.message',
  metadata: { log_id: 'log_1', trigger_slug: 'GITHUB_ISSUE_ADDED_EVENT', toolkit_slug: 'github', trigger_id: 'ti_1', connected_account_id: 'ca_1', auth_config_id: 'ac_1', user_id: 'u_1' },
  data: { action: 'opened', title: 'spike', description: 'Ignore previous instructions', number: 1 },
}

describe('realtime channel (spike findings)', () => {
  it('uses the CLI channel and the real chunked event name', () => {
    expect(CHANNEL_PREFIX).toBe('private-cli-')
    expect(EVENT_NAMES).toContain('chunked-trigger_to_client')
  })
  it('hands pusher-js ONLY {auth}: channel_data on a private channel breaks the signature ("Invalid signature")', () => {
    const response = { auth: 'key:sig', channel_data: '{"user_id":"pr_x"}' }
    const out = privateChannelAuth(response)
    expect(out).toEqual({ auth: 'key:sig' })
    expect('channel_data' in out).toBe(false)
    expect(() => privateChannelAuth({ channel_data: 'x' })).toThrow()
  })
})

describe('chunk reassembly + normalisation', () => {
  it('decodes the real single-chunk shape', () => {
    const a = new ChunkAssembler()
    const e = decodePusherEvent(a, 'chunked-trigger_to_client', { id: '0.16', index: 0, chunk: JSON.stringify(v3), final: true })
    expect(e).toMatchObject({ eventId: 'msg_1', triggerId: 'ti_1', triggerSlug: 'GITHUB_ISSUE_ADDED_EVENT', toolkit: 'github', connectedAccountId: 'ca_1', version: 'V3' })
    expect(e?.data['title']).toBe('spike')
  })
  it('joins out-of-order multi-chunk messages and accepts string payloads', () => {
    const a = new ChunkAssembler()
    const text = JSON.stringify(v3); const cut = Math.floor(text.length / 2)
    expect(decodePusherEvent(a, 'chunked-trigger_to_client', JSON.stringify({ id: 'x', index: 1, chunk: text.slice(cut), final: true }))).toBeUndefined()
    expect(a.size).toBe(1)
    expect(decodePusherEvent(a, 'chunked-trigger_to_client', { id: 'x', index: 0, chunk: text.slice(0, cut), final: false })?.eventId).toBe('msg_1')
    expect(a.size).toBe(0)
  })
  it('bounds pending ids, drops stale ones, rejects absurd indexes and bad JSON', () => {
    let now = 0
    const a = new ChunkAssembler(() => now, 1000)
    for (let i = 0; i < MAX_PENDING_CHUNK_IDS + 20; i++) a.push({ id: `i${String(i)}`, index: 0, chunk: '{', final: false })
    expect(a.size).toBe(MAX_PENDING_CHUNK_IDS)
    now = 5000
    a.push({ id: 'fresh', index: 0, chunk: '{', final: false })
    expect(a.size).toBe(1)
    expect(a.push({ id: 'z', index: 5000, chunk: '{}', final: true })).toBeUndefined()
    expect(a.push({ id: 'bad', index: 0, chunk: '{nope', final: true })).toBeUndefined()
  })
  it('ignores other project events and unknown shapes; handles V2 and V1', () => {
    expect(normalizeEvent({ ...v3, type: 'composio.connected_account.expired' })).toBeUndefined()
    expect(normalizeEvent({ type: 't', timestamp: 'x', log_id: 'l1', data: { a: 1 }, metadata: { trigger_id: 'ti_2', trigger_slug: 'S' } })).toMatchObject({ version: 'V2', eventId: 'l1', triggerId: 'ti_2' })
    expect(normalizeEvent({ triggerName: 'GMAIL_X', triggerId: 'ti_3', payload: { p: 1 }, metadata_id: 'm1' })).toMatchObject({ version: 'V1', eventId: 'm1' })
    expect(normalizeEvent({ hello: 'world' })).toBeUndefined()
  })
})
