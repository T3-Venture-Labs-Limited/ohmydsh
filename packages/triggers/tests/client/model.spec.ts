// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { MEETING_PROMPT, TEMPLATE_IDS, curlExample, draftFrom, prettyModelId, relative, runTone, templateRequest, toRequest } from '../../src/client/model.ts'
import type { Draft } from '../../src/client/model.ts'

const names = { meeting: 'Meeting summary', webhook: 'Generic webhook', github: 'GitHub webhook', folder: 'Folder drop', composio: 'Composio trigger', blank: '' }
const st = { defaultCwd: '/home/me/proj' }

describe('templates', () => {
  it('meeting summary (voxtype) is prefilled exactly as specified', () => {
    const r = templateRequest('meeting', st, names)
    expect(r.source).toEqual({ kind: 'file', path: '~/meetings', pattern: 'transcript.md', settleMs: 8000, ignoreExisting: true })
    expect(r.target).toEqual({ mode: 'new', cwd: '/home/me/proj', model: { provider: 'claude', model: 'claude-sonnet-5-5', reasoningEffort: 'medium' }, sandbox: 'read-only', tools: 'read', title: 'Meeting summary: {{file.dirname}}' })
    expect(r.prompt).toBe(MEETING_PROMPT)
    expect(r.prompt.startsWith('A meeting I recorded with voxtype has just finished transcribing.')).toBe(true)
    expect(r.prompt.endsWith('Do not modify anything in the meeting folder.\n\n{{event_fenced}}')).toBe(true)
    expect(r.name).toBe('Meeting summary')
  })
  it('every template round-trips through the draft into a valid request (blank needs a name and prompt)', () => {
    for (const id of TEMPLATE_IDS) {
      const req = templateRequest(id, st, names)
      const d = draftFrom(req)
      if (id === 'blank') { expect(toRequest(d).errors).toMatchObject({ name: 'required', prompt: 'required' }); continue }
      if (id === 'composio') { expect(toRequest(d).errors).toEqual({ slug: 'required' }); continue }
      const out = toRequest(d)
      expect(out.errors, id).toEqual({})
      expect(out.request?.source, id).toEqual(req.source)
      expect(out.request?.target, id).toEqual(req.target)
      expect(out.request?.prompt, id).toBe(req.prompt)
    }
    expect(templateRequest('github', st, names).source).toEqual({ kind: 'webhook', auth: 'hmac-sha256', events: ['push', 'pull_request', 'issues'] })
  })
})

describe('draft -> SaveRequest', () => {
  const base = (): Draft => draftFrom(templateRequest('webhook', st, names))
  it('webhook: auth + trimmed event list', () => {
    const d = { ...base(), auth: 'standard-webhooks' as const, events: ' push, ,pull_request ' }
    expect(toRequest(d).request?.source).toEqual({ kind: 'webhook', auth: 'standard-webhooks', events: ['push', 'pull_request'] })
  })
  it('file: seconds -> ms, sibling condition only when all three are set', () => {
    const d: Draft = { ...base(), kind: 'file', path: ' ~/drop ', pattern: '*.pdf', settleSec: '2.5' }
    expect(toRequest(d).request?.source).toEqual({ kind: 'file', path: '~/drop', pattern: '*.pdf', settleMs: 2500, ignoreExisting: true })
    expect(toRequest({ ...d, sibFile: 'metadata.json', sibField: 'status', sibEquals: 'completed' }).request?.source)
      .toMatchObject({ requireSibling: { file: 'metadata.json', field: 'status', equals: 'completed' } })
    expect(toRequest({ ...d, sibFile: 'metadata.json' }).errors).toEqual({ sibling: 'sibling' })
    expect(toRequest({ ...d, path: '', settleSec: 'x' }).errors).toEqual({ path: 'required', settleSec: 'number' })
  })
  it('composio: slug, optional instance id', () => {
    const d: Draft = { ...base(), kind: 'composio', slug: 'GMAIL_NEW_GMAIL_MESSAGE' }
    expect(toRequest(d).request?.source).toEqual({ kind: 'composio', triggerSlug: 'GMAIL_NEW_GMAIL_MESSAGE' })
    expect(toRequest({ ...d, instanceId: ' ti_1 ' }).request?.source).toEqual({ kind: 'composio', triggerSlug: 'GMAIL_NEW_GMAIL_MESSAGE', triggerInstanceId: 'ti_1' })
  })
  it('limits must be whole numbers; id and maxEventChars are carried', () => {
    expect(toRequest({ ...base(), maxPerHour: '0', minIntervalSec: '-1' }).errors).toEqual({ maxPerHour: 'positive', minIntervalSec: 'number' })
    const r = toRequest({ ...base(), id: 'a9', maxEventChars: 5000, maxPerHour: '3', minIntervalSec: '0' }).request
    expect(r).toMatchObject({ id: 'a9', maxEventChars: 5000, limits: { maxPerHour: 3, minIntervalSec: 0 } })
  })
})

describe('display helpers', () => {
  it('pretty model ids', () => {
    expect(prettyModelId('claude-sonnet-5-5')).toBe('Claude Sonnet 5.5')
    expect(prettyModelId('deepseek-v4')).toBe('Deepseek V4')
  })
  it('run tones', () => {
    expect(['delivered', 'skipped', 'failed', 'rejected', 'pending', 'queued'].map((s) => runTone(s as never))).toEqual(['ok', 'idle', 'error', 'error', 'idle', 'warn'])
  })
  it('curl examples match the auth scheme', () => {
    const url = 'http://127.0.0.1:3080/hooks/a1'
    expect(curlExample(url, 'token')).toContain('-H "Authorization: Bearer $SECRET"')
    const hmac = curlExample(url, 'hmac-sha256')
    expect(hmac.split('\n')).toHaveLength(2)
    expect(hmac).toContain('openssl dgst -sha256 -hmac "$SECRET"')
    expect(hmac).toContain('X-Hub-Signature-256: sha256=$SIG')
    expect(curlExample(url, 'standard-webhooks')).toMatch(/webhook-id: .*webhook-timestamp: .*webhook-signature: v1,/s)
    expect(curlExample(url, 'none')).not.toMatch(/SECRET/)
  })
  it('relative time buckets', () => {
    expect(relative(0, 10_000)).toEqual({ unit: 'now', n: 0 })
    expect(relative(0, 5 * 60_000)).toEqual({ unit: 'min', n: 5 })
    expect(relative(0, 3 * 3_600_000)).toEqual({ unit: 'hour', n: 3 })
    expect(relative(0, 30 * 86_400_000).unit).toBe('date')
  })
})
