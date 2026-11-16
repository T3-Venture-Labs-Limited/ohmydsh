import { act } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import Panel from '../../src/client/panel.tsx'
import { MEETING_PROMPT } from '../../src/client/model.ts'
import type { SaveRequest, TriggersState } from '../../src/shared/types.ts'
import { automation, button, catalog, click, fakeApi, field, flush, render, run, state, t, tab, type } from './harness.tsx'

let cleanup: (() => void) | undefined
afterEach(() => { cleanup?.(); cleanup = undefined; vi.unstubAllGlobals(); document.body.innerHTML = '' })

async function mount(s: TriggersState, extra: Record<string, (b: Record<string, unknown>) => unknown> = {}) {
  let current = s
  const api = fakeApi({ state: () => current, models: () => catalog, runs: () => current.runs, ...extra })
  const openSession = vi.fn()
  const r = await render(<Panel t={t} openSession={openSession} />)
  cleanup = r.unmount
  return { ...r, api, openSession, setState: (next: TriggersState) => { current = next } }
}

describe('list', () => {
  it('renders automations from state: name, source chip, target summary, last run, failures, enabled switch', async () => {
    const s = state({
      automations: [
        automation({ lastRun: run({ status: 'failed', at: Date.now() - 5 * 60_000 }), consecutiveFailures: 2 }),
        automation({ id: 'a2', name: 'Meetings', enabled: false, source: { kind: 'file', path: '/m', pattern: 'transcript.md', settleMs: 8000, ignoreExisting: true }, target: { mode: 'reuse', cwd: '/x', model: null, sandbox: 'workspace-write', tools: 'standard', title: '' } }),
      ],
      runs: [run(), { ...run({ runId: 'r2', status: 'queued', summary: 'transcript.md in m1' }), sessionId: '' }],
    })
    const { host } = await mount(s)
    expect(host.querySelector('.dk-page__title')?.textContent).toBe('Triggers')
    expect(host.textContent).toContain('Run an agent when something happens: a webhook call, a new file, or a Composio event.')
    const rows = host.querySelectorAll('[data-automation]')
    expect(rows).toHaveLength(2)
    const first = rows[0] as HTMLElement
    expect(first.textContent).toContain('Deploy hook')
    expect(first.querySelector('.tr-chip')?.textContent).toBe('Webhook')
    expect(first.textContent).toContain('New chat · Claude Sonnet 5.5 · read-only')
    expect(first.textContent).toContain('Failed')
    expect(first.textContent).toContain('5 min ago')
    expect(first.textContent).toContain('2 failures')
    expect(first.querySelector('[role="switch"]')?.getAttribute('aria-checked')).toBe('true')
    const second = rows[1] as HTMLElement
    expect(second.querySelector('.tr-chip')?.textContent).toBe('File')
    expect(second.textContent).toContain('One chat · Profile default · can edit files')
    expect(second.textContent).toContain('No runs yet')
    expect(second.querySelector('[role="switch"]')?.getAttribute('aria-checked')).toBe('false')
    // runs table: delivered + queued, Open chat only with a session
    const table = host.querySelector('[data-testid="runs"]') as HTMLElement
    expect(table.querySelectorAll('tbody tr')).toHaveLength(2)
    expect(table.textContent).toContain('Delivered')
    expect(table.textContent).toContain('Queued')
    expect([...table.querySelectorAll('button')].filter((b) => b.textContent === 'Open chat')).toHaveLength(1)
  })

  it('enabled switch calls setEnabled; Pause all calls setPaused; both refresh from the response', async () => {
    const s = state({ automations: [automation()] })
    const { host, api } = await mount(s, {
      setEnabled: (b) => ({ ...s, automations: [automation({ enabled: b.enabled as boolean })] }),
      setPaused: (b) => ({ ...s, paused: b.paused as boolean }),
    })
    await click(host.querySelector('[data-automation="a1"] [role="switch"]'))
    expect(api.of('setEnabled')).toEqual([{ id: 'a1', enabled: false }])
    expect(host.querySelector('[data-automation="a1"] [role="switch"]')?.getAttribute('aria-checked')).toBe('false')
    await click(button('Pause all', host))
    expect(api.of('setPaused')).toEqual([{ paused: true }])
    expect(host.textContent).toContain('All automations are paused.')
  })

  it('Open chat calls the openSession callback with the run session', async () => {
    const { host, openSession } = await mount(state({ runs: [run({ sessionId: 'sess-77' })] }))
    await click(button('Open chat', host))
    expect(openSession).toHaveBeenCalledWith('sess-77')
  })

  it('refreshes on visibilitychange (no polling) and from Refresh', async () => {
    const { host, api } = await mount(state())
    expect(api.of('state')).toHaveLength(1)
    await flush(30)
    expect(api.of('state')).toHaveLength(1)
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' })
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
    await flush()
    expect(api.of('state')).toHaveLength(2)
    await click(button('Refresh', host))
    expect(api.of('state')).toHaveLength(3)
  })

  it('shows a load error with Retry', async () => {
    fakeApi({})
    const r = await render(<Panel t={t} openSession={() => {}} />)
    cleanup = r.unmount
    expect(r.host.textContent).toContain('Could not load Triggers')
    expect(r.host.textContent).toContain('no route state')
    expect(r.host.querySelector('.tr-scroll > .dk-page')).not.toBeNull()
  })

  it('empty state offers the templates; Composio is disabled without dsh-composio', async () => {
    const { host } = await mount(state())
    expect(host.textContent).toContain('No automations yet')
    expect(button('Meeting summary (voxtype)', host).disabled).toBe(false)
    expect(button('Composio trigger', host).disabled).toBe(true)
  })
})

describe('template picker + editor', () => {
  it('New automation -> Meeting summary prefills the editor and Create sends the exact SaveRequest', async () => {
    const created = automation({ id: 'm1', name: 'Meeting summary', source: { kind: 'file', path: '/home/me/meetings', pattern: 'transcript.md', settleMs: 8000, ignoreExisting: true }, secretHint: null })
    let s = state({ hasComposio: false })
    const { host, api, setState } = await mount(s, {
      save: () => { s = { ...s, automations: [created] }; setState(s); return { automation: created, warnings: ['Folder /home/me/meetings does not exist yet.'] } },
    })
    await click(button('New automation', host))
    const picker = document.querySelector('[data-testid="template-picker"]') as HTMLElement
    expect(picker.querySelectorAll('button')).toHaveLength(6)
    expect((picker.querySelector('[data-template="composio"]') as HTMLButtonElement).disabled).toBe(true)
    expect(picker.textContent).toContain('Needs the dsh-composio plugin')
    await click(picker.querySelector('[data-template="meeting"]'))

    expect(field('Name').value).toBe('Meeting summary')
    expect(field('Folder').value).toBe('~/meetings')
    expect(field('File name pattern').value).toBe('transcript.md')
    expect(field('Wait until quiet (seconds)').value).toBe('8')
    expect(field('Instructions for the agent').value).toBe(MEETING_PROMPT)
    expect(field('Chat title').value).toBe('Meeting summary: {{file.dirname}}')
    expect(field('Model').value).toBe('claude\u0000claude-sonnet-5-5')
    expect(field('Reasoning effort').value).toBe('medium')
    expect(tab('Files', 'Read-only').getAttribute('aria-selected')).toBe('true')
    expect(tab('Tools', 'Read-only tools').getAttribute('aria-selected')).toBe('true')
    // model select: Profile default first, then models grouped by provider
    const model = field('Model') as HTMLSelectElement
    expect(model.options[0]?.textContent).toBe('Profile default')
    expect([...model.querySelectorAll('optgroup')].map((g) => g.label)).toEqual(['Claude', 'DeepSeek'])

    await click(button('Create', host))
    const sent = api.of('save')[0] as unknown as SaveRequest
    expect(sent).toEqual({
      name: 'Meeting summary', description: 'Analyse each new voxtype meeting transcript.', enabled: true,
      source: { kind: 'file', path: '~/meetings', pattern: 'transcript.md', settleMs: 8000, ignoreExisting: true },
      target: { mode: 'new', cwd: '/home/me/proj', model: { provider: 'claude', model: 'claude-sonnet-5-5', reasoningEffort: 'medium' }, sandbox: 'read-only', tools: 'read', title: 'Meeting summary: {{file.dirname}}' },
      prompt: MEETING_PROMPT, limits: { maxPerHour: 12, minIntervalSec: 10 },
    })
    // now on the saved detail, with the save warnings in a callout
    expect(host.textContent).toContain('Saved, with warnings')
    expect(host.textContent).toContain('Folder /home/me/meetings does not exist yet.')
    expect(button('Save', host)).toBeTruthy()
  })

  it('editor builds the right source for each kind (webhook, file, composio) and model / effort / target choices', async () => {
    const s = state({ hasComposio: true })
    const { host, api } = await mount(s, {
      save: (b) => ({ automation: automation({ ...(b as object), id: 'n1' }), warnings: [] }),
      composioAccounts: () => ({ available: true, listener: { state: 'live', lastError: null }, toolkits: [{ slug: 'gmail', name: 'Gmail', accounts: [{ id: 'ca_1', label: 'work', status: 'ACTIVE' }] }] }),
      composioTriggerTypes: (b) => (b.toolkit === 'gmail' ? [{ slug: 'GMAIL_NEW_GMAIL_MESSAGE', name: 'New Gmail message', description: 'Fires on new mail', instructions: '' }] : []),
    })
    await click(button('New automation', host))
    await click(document.querySelector('[data-template="blank"]'))
    await type(field('Name'), 'Hook')
    await type(field('Instructions for the agent'), 'Do it.\n{{event_fenced}}')
    await type(field('Authentication'), 'hmac-sha256')
    await type(field('Only these event types'), 'push, release')
    await type(field('Model'), 'deepseek\u0000deepseek-v4')
    expect(() => field('Reasoning effort')).toThrow()
    await type(field('Workspace'), '/home/me/notes')
    await click(tab('Chat', 'One chat for all events'))
    await click(tab('Files', 'Can edit workspace files'))
    await click(tab('Tools', 'Normal tools'))
    await type(field('Max runs per hour'), '3')
    await click(button('Create', host))
    expect(api.of('save')[0]).toMatchObject({
      name: 'Hook', source: { kind: 'webhook', auth: 'hmac-sha256', events: ['push', 'release'] },
      target: { mode: 'reuse', cwd: '/home/me/notes', model: { provider: 'deepseek', model: 'deepseek-v4' }, sandbox: 'workspace-write', tools: 'standard' },
      limits: { maxPerHour: 3, minIntervalSec: 10 },
    })

    // file
    await click(button('Back', host))
    await click(button('New automation', host))
    await click(document.querySelector('[data-template="blank"]'))
    await type(field('Name'), 'Drop')
    await type(field('Instructions for the agent'), 'x')
    await click(tab('Source', 'File'))
    await type(field('Folder'), '~/in')
    await type(field('File name pattern'), '*.md')
    await type(field('Wait until quiet (seconds)'), '3')
    await type(field('JSON file next to the match'), 'metadata.json')
    await click(button('Create', host))
    expect(api.of('save')).toHaveLength(1)
    expect(document.body.textContent).toContain('Fill in all three, or leave all three empty.')
    await type(field('Field'), 'status')
    await type(field('Equals'), 'completed')
    await type(field('Model'), '')
    await click(button('Create', host))
    expect(api.of('save')[1]).toMatchObject({
      source: { kind: 'file', path: '~/in', pattern: '*.md', settleMs: 3000, ignoreExisting: true, requireSibling: { file: 'metadata.json', field: 'status', equals: 'completed' } },
      target: { model: null },
    })

    // composio
    await click(button('Back', host))
    await click(button('New automation', host))
    await click(document.querySelector('[data-template="composio"]'))
    await flush()
    expect(host.textContent).toContain('The trigger is created in Composio when you save')
    await type(field('Connected account'), 'ca_1')
    await flush()
    expect(api.of('composioTriggerTypes')[0]).toEqual({ toolkit: 'gmail' })
    await type(field('Trigger'), 'GMAIL_NEW_GMAIL_MESSAGE')
    expect(host.textContent).toContain('Fires on new mail')
    await click(button('Create', host))
    const sent = api.of('save')[2] as unknown as SaveRequest
    expect(sent).toMatchObject({ name: 'Composio trigger', source: { kind: 'composio', triggerSlug: 'GMAIL_NEW_GMAIL_MESSAGE', connectedAccountId: 'ca_1' } })
    expect((sent.source as { triggerInstanceId?: string }).triggerInstanceId).toBeUndefined()
  })

  it('Preview prompt sends the draft and shows the rendered text in a modal', async () => {
    const { host, api } = await mount(state(), { preview: () => ({ prompt: 'RENDERED <untrusted_event>{}</untrusted_event>', title: 'Meeting summary: m1' }) })
    await click(button('New automation', host))
    await click(document.querySelector('[data-template="meeting"]'))
    await click(button('Preview prompt', host))
    expect((api.of('preview')[0] as { draft: SaveRequest }).draft.prompt).toBe(MEETING_PROMPT)
    expect(document.querySelector('[data-testid="preview-text"]')?.textContent).toBe('RENDERED <untrusted_event>{}</untrusted_event>')
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Meeting summary: m1')
  })
})

describe('webhook detail', () => {
  it('shows the secret in full only right after create, then only the hint; rotate shows the new one once', async () => {
    const created = automation({ id: 'w1', name: 'Hook', secretHint: 'whsec_ab…9f', webhookUrl: 'http://127.0.0.1:3080/hooks/w1' })
    let s = state()
    const { host, api, setState } = await mount(s, {
      save: () => { s = { ...s, automations: [created] }; setState(s); return { automation: created, secret: 'whsec_FULLSECRET1', warnings: [] } },
      rotateSecret: () => ({ automation: { ...created, updatedAt: 2 }, secret: 'whsec_ROTATED2', warnings: [] }),
    })
    await click(button('New automation', host))
    await click(document.querySelector('[data-template="webhook"]'))
    expect(host.textContent).toContain('The URL and secret appear here after you save.')
    await click(button('Create', host))
    const card = host.querySelector('[data-testid="webhook-card"]') as HTMLElement
    expect(card.textContent).toContain('http://127.0.0.1:3080/hooks/w1')
    expect(card.textContent).toContain('https://<tailnet-host>/hooks/w1')
    expect(card.textContent).toContain('-H "Authorization: Bearer $SECRET"')
    expect(card.querySelector('[data-testid="secret"]')?.textContent).toContain('whsec_FULLSECRET1')
    expect(card.textContent).toContain('it will not be shown again')

    // leave and come back: only the hint
    await click(button('Back', host))
    await click(host.querySelector('[data-automation="w1"] .tr-item__open'))
    const again = host.querySelector('[data-testid="secret"]') as HTMLElement
    expect(again.textContent).not.toContain('whsec_FULLSECRET1')
    expect(again.textContent).toContain('whsec_ab…9f')

    // rotate (confirm) -> new secret once
    await click(button('Rotate secret', host))
    await click(button('Rotate', document.querySelector('[role="dialog"]') as HTMLElement))
    expect(api.of('rotateSecret')).toEqual([{ id: 'w1' }])
    expect(host.querySelector('[data-testid="secret"]')?.textContent).toContain('whsec_ROTATED2')
  })

  it('Test fires the saved automation and offers Open chat for the resulting run', async () => {
    const { host, api, openSession } = await mount(state({ automations: [automation()] }), { test: () => run({ runId: 't1', test: true, sessionId: 'sess-test', status: 'delivered', summary: 'Test event' }) })
    await click(host.querySelector('[data-automation="a1"] .tr-item__open'))
    await click(button('Test', host))
    expect(api.of('test')).toEqual([{ id: 'a1' }])
    const result = host.querySelector('[data-testid="test-result"]') as HTMLElement
    expect(result.textContent).toContain('Delivered')
    await click(button('Open chat', result))
    expect(openSession).toHaveBeenCalledWith('sess-test')
  })

  it('Delete asks for confirmation, then returns to the list', async () => {
    const s = state({ automations: [automation()] })
    const { host, api } = await mount(s, { delete: () => ({ ...s, automations: [] }) })
    await click(host.querySelector('[data-automation="a1"] .tr-item__open'))
    await click(button('Delete', host))
    expect(api.of('delete')).toHaveLength(0)
    await click(button('Delete', document.querySelector('[role="dialog"]') as HTMLElement))
    expect(api.of('delete')).toEqual([{ id: 'a1' }])
    expect(host.textContent).toContain('No automations yet')
  })
})
