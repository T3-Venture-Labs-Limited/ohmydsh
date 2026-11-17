// Detail / editor view for one automation (new or saved): fields per source kind, target, prompt with variable help,
// limits; Save, Preview prompt, Test, Delete; the webhook card; this automation's runs.
import { useEffect, useMemo, useState } from 'react'
import { Button, Card, Modal, Section, SegmentedControl, Select, TextArea, TextField } from '../kit/index.ts'
import type { SelectOption } from '../kit/index.ts'
import type { AutomationView, RunRow, SaveRequest, SaveResponse, SourceKind, TriggersState, WebhookAuth } from '../shared/types.ts'
import { call, errorText } from './api.ts'
import type { Catalog } from './api.ts'
import type { T } from './locale.ts'
import { draftFrom, prettyModelId, toRequest } from './model.ts'
import type { Draft, DraftErrors, DraftField } from './model.ts'
import { RunsTable } from './runs.tsx'
import { Callout, RunBadge } from './ui.tsx'
import { WebhookCard, authHint } from './webhook-card.tsx'
import { ComposioFields } from './composio-fields.tsx'

const CUSTOM = '\u0000custom'
const SEP = '\u0000'

export interface EditorProps {
  t: T
  state: TriggersState
  /** The saved automation (from state) or a template request for a new one. */
  initial: AutomationView | SaveRequest
  catalog: Catalog | null | undefined
  catalogError: string | undefined
  /** Full secret shown once, right after create / rotate. */
  freshSecret: string | undefined
  /** Warnings from the last save of this automation (kept by the page across the create -> detail remount). */
  warnings: string[] | undefined
  openSession: (id: string) => void
  onBack: () => void
  /** After save / rotate: the page refreshes state and keeps the returned secret for this automation. */
  onSaved: (response: SaveResponse) => Promise<void>
  onDeleted: (state: TriggersState) => void
  /** Re-read the page state (after Test). */
  refresh: () => Promise<void>
}

export function Editor({ t, state, initial, catalog, catalogError, freshSecret, warnings, openSession, onBack, onSaved, onDeleted, refresh }: EditorProps) {
  const saved = 'createdAt' in initial ? initial : undefined
  const [draft, setDraft] = useState<Draft>(() => draftFrom(initial))
  const [errors, setErrors] = useState<DraftErrors>({})
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | undefined>()
  const [preview, setPreview] = useState<{ prompt: string; title: string } | undefined>()
  const [testRun, setTestRun] = useState<RunRow | undefined>()
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [runs, setRuns] = useState<RunRow[] | undefined>()
  const [customCwd, setCustomCwd] = useState(() => !state.workspaces.some((w) => w.path === draftFrom(initial).cwd))

  // A saved automation that changed on the host (save, rotate, toggle) resets the form to its saved state.
  const savedKey = saved === undefined ? '' : `${saved.id}:${String(saved.updatedAt)}`
  useEffect(() => { if (saved !== undefined) setDraft(draftFrom(saved)) }, [savedKey]) // eslint-disable-line react-hooks/exhaustive-deps

  // This automation's runs: refetched whenever the page state is refreshed (visibility, mutations, Refresh).
  useEffect(() => {
    if (saved === undefined) { setRuns(undefined); return }
    let live = true
    call<RunRow[]>('runs', { id: saved.id, limit: 50 }).then((r) => { if (live) setRuns(r) }).catch(() => { if (live) setRuns(undefined) })
    return () => { live = false }
  }, [saved?.id, state]) // eslint-disable-line react-hooks/exhaustive-deps

  const set = <K extends keyof Draft>(key: K, value: Draft[K]): void => {
    setDraft((d) => ({ ...d, [key]: value }))
    setErrors((e) => { const n = { ...e }; delete n[key as DraftField]; if (key === 'sibFile' || key === 'sibField' || key === 'sibEquals') delete n.sibling; return n })
  }

  const built = useMemo(() => toRequest(draft), [draft])
  const savedRequest = useMemo(() => (saved === undefined ? undefined : toRequest(draftFrom(saved)).request), [saved])
  const dirty = saved === undefined || JSON.stringify(built.request) !== JSON.stringify(savedRequest)

  const errorFor = (field: DraftField): { error?: string } => {
    const e = errors[field]
    if (e === undefined) return {}
    return { error: e === 'required' ? t('errRequired') : e === 'positive' ? t('errPositive') : e === 'sibling' ? t('errSibling') : t('errNumber') }
  }

  const validRequest = (): SaveRequest | undefined => {
    const { request, errors: found } = toRequest(draft)
    setErrors(found)
    if (request === undefined) { setErr(t('fixErrors')); return undefined }
    setErr(undefined)
    return request
  }

  const guarded = async (work: () => Promise<void>): Promise<void> => {
    setBusy(true)
    try { await work() } catch (e) { setErr(errorText(e)) } finally { setBusy(false) }
  }

  const save = (): Promise<void> => guarded(async () => {
    const request = validRequest()
    if (request === undefined) return
    // The list's enabled switch acts immediately; never let a stale form value override it.
    const body: SaveRequest = saved === undefined ? request : { ...request, enabled: saved.enabled }
    const response = await call<SaveResponse>('save', body)
    await onSaved(response)
  })

  const runPreview = (): Promise<void> => guarded(async () => {
    const request = validRequest()
    if (request === undefined) return
    setPreview(await call<{ prompt: string; title: string }>('preview', { ...(saved === undefined ? {} : { id: saved.id }), draft: request }))
  })

  const runTest = (): Promise<void> => guarded(async () => {
    if (saved === undefined) return
    setTestRun(await call<RunRow>('test', { id: saved.id }))
    await refresh()
  })

  const remove = (): Promise<void> => guarded(async () => {
    if (saved === undefined) return
    setConfirmDelete(false)
    onDeleted(await call<TriggersState>('delete', { id: saved.id }))
  })

  const rotate = (): Promise<void> => guarded(async () => {
    if (saved === undefined) return
    await onSaved(await call<SaveResponse>('rotateSecret', { id: saved.id }))
  })

  // ---------- model options ----------
  const modelValue = draft.model === null ? '' : `${draft.model.provider}${SEP}${draft.model.model}`
  const modelOptions: SelectOption[] = [{ value: '', label: t('profileDefault') }]
  for (const g of catalog?.groups ?? []) for (const m of g.models) modelOptions.push({ value: `${g.id}${SEP}${m.id}`, label: m.name, group: g.name })
  if (draft.model !== null && !modelOptions.some((o) => o.value === modelValue)) {
    modelOptions.push({ value: modelValue, label: t('modelUnknown', { model: `${draft.model.provider} / ${prettyModelId(draft.model.model)}` }) })
  }
  const modelInfo = draft.model === null ? undefined : catalog?.groups.find((g) => g.id === draft.model?.provider)?.models.find((m) => m.id === draft.model?.model)
  const efforts = modelInfo?.reasoning?.efforts ?? []
  const showEffort = efforts.length > 0 || (draft.model?.reasoningEffort !== undefined && modelInfo === undefined)
  const effortOptions: SelectOption[] = [{ value: '', label: t('effortDefault') }, ...efforts.map((e) => ({ value: e.id, label: e.name }))]
  const currentEffort = draft.model?.reasoningEffort
  if (currentEffort !== undefined && !effortOptions.some((o) => o.value === currentEffort)) effortOptions.push({ value: currentEffort, label: currentEffort })

  const pickModel = (value: string): void => {
    if (value === '') { set('model', null); return }
    const [provider = '', model = ''] = value.split(SEP)
    const info = catalog?.groups.find((g) => g.id === provider)?.models.find((m) => m.id === model)
    const keep = draft.model?.reasoningEffort
    const effort = keep !== undefined && info?.reasoning?.efforts.some((e) => e.id === keep) === true ? keep : info?.reasoning?.defaultEffort
    set('model', { provider, model, ...(effort === undefined ? {} : { reasoningEffort: effort }) })
  }
  const pickEffort = (value: string): void => {
    if (draft.model === null) return
    const { reasoningEffort: _drop, ...rest } = draft.model
    void _drop
    set('model', value === '' ? rest : { ...rest, reasoningEffort: value })
  }

  // ---------- workspace options ----------
  const workspaceOptions: SelectOption[] = [...state.workspaces.map((w) => ({ value: w.path, label: w.title === '' ? w.path : `${w.title} — ${w.path}` })), { value: CUSTOM, label: t('workspaceCustom') }]
  const workspaceValue = customCwd ? CUSTOM : draft.cwd

  const kindOptions = [
    { value: 'webhook' as const, label: t('sourceWebhook') },
    { value: 'file' as const, label: t('sourceFile') },
    { value: 'composio' as const, label: t('sourceComposio'), ...(state.hasComposio || draft.kind === 'composio' ? {} : { disabled: true, title: t('tplComposioMissing') }) },
  ]
  const authOptions: { value: WebhookAuth; label: string }[] = [
    { value: 'token', label: t('authToken') }, { value: 'hmac-sha256', label: t('authHmac') },
    { value: 'standard-webhooks', label: t('authStandard') }, { value: 'none', label: t('authNone') },
  ]

  const title = saved === undefined ? (draft.name.trim() === '' ? t('detailNew') : draft.name) : saved.name

  return (
    <>
      <div className="tr-detail-bar">
        <Button variant="ghost" size="sm" onClick={onBack} icon={<BackIcon />}>{t('back')}</Button>
        <div className="tr-actions">
          <Button variant="outline" size="sm" disabled={busy} onClick={() => { void runPreview() }}>{t('preview')}</Button>
          <Button variant="outline" size="sm" disabled={busy || saved === undefined} title={saved === undefined ? t('testNeedsSave') : dirty ? t('testUnsaved') : t('testHint')} onClick={() => { void runTest() }}>{t('test')}</Button>
          {saved !== undefined && <Button variant="danger" size="sm" disabled={busy} onClick={() => { setConfirmDelete(true) }}>{t('delete')}</Button>}
          <Button variant="primary" size="sm" disabled={busy || !dirty} onClick={() => { void save() }}>{busy ? t('saving') : saved === undefined ? t('create') : t('save')}</Button>
        </div>
      </div>
      <h2 className="dk-page__title" style={{ fontSize: 17, lineHeight: '24px' }}>{title}</h2>

      {err !== undefined && <Callout tone="error">{err}</Callout>}
      {warnings !== undefined && warnings.length > 0 && (
        <Callout tone="warn" title={t('warningsTitle')}><ul>{warnings.map((w) => <li key={w}>{w}</li>)}</ul></Callout>
      )}
      {warnings !== undefined && warnings.length === 0 && !dirty && <Callout tone="ok">{t('savedOk')}</Callout>}
      {saved !== undefined && !saved.enabled && saved.consecutiveFailures >= 3 && <Callout tone="warn">{t('autoDisabled')}</Callout>}
      {testRun !== undefined && (
        <Callout tone={testRun.status === 'failed' || testRun.status === 'rejected' ? 'error' : 'info'} title={t('testResult')}>
          <div className="tr-actions" data-testid="test-result">
            <RunBadge t={t} status={testRun.status} />
            <span>{testRun.summary}</span>
            {(testRun.error ?? testRun.reason) !== undefined && <span className="tr-hint">{testRun.error ?? testRun.reason}</span>}
            {testRun.sessionId !== undefined && testRun.sessionId !== '' && (
              <Button variant="outline" size="sm" onClick={() => { openSession(testRun.sessionId ?? '') }}>{t('openChat')}</Button>
            )}
          </div>
        </Callout>
      )}

      <Section title={t('sectionGeneral')}>
        <Card padded>
          <div className="tr-grid">
            <TextField label={t('nameLabel')} value={draft.name} onChange={(e) => { set('name', e.target.value) }} {...errorFor('name')} />
            <TextField label={t('descriptionLabel')} hint={t('descriptionHint')} value={draft.description} onChange={(e) => { set('description', e.target.value) }} />
          </div>
        </Card>
      </Section>

      <Section title={t('sectionSource')}>
        <Card padded>
          <div className="tr-form">
            <div className="tr-field-row">
              <span className="tr-field-row__label" id="tr-kind-label">{t('sourceKind')}</span>
              <div className="tr-segment-wrap">
                <SegmentedControl<SourceKind> id="tr-kind" label={t('sourceKind')} value={draft.kind} onChange={(v) => { set('kind', v) }} options={kindOptions} />
              </div>
              {draft.kind === 'composio' && !state.hasComposio && <span className="tr-hint">{t('sourceComposioNeedsPlugin')}</span>}
            </div>
            {draft.kind === 'webhook' && (
              <div className="tr-grid">
                <Select label={t('authLabel')} value={draft.auth} onChange={(v) => { set('auth', v as WebhookAuth) }} options={authOptions} hint={authHint(t, draft.auth)} />
                <TextField label={t('eventsLabel')} hint={t('eventsHint')} value={draft.events} placeholder="push, pull_request" onChange={(e) => { set('events', e.target.value) }} spellCheck={false} />
              </div>
            )}
            {draft.kind === 'file' && (
              <>
                <div className="tr-grid">
                  <TextField label={t('folderLabel')} hint={t('folderHint')} value={draft.path} placeholder="~/meetings" onChange={(e) => { set('path', e.target.value) }} spellCheck={false} {...errorFor('path')} />
                  <TextField label={t('patternLabel')} hint={t('patternHint')} value={draft.pattern} placeholder="*.md" onChange={(e) => { set('pattern', e.target.value) }} spellCheck={false} {...errorFor('pattern')} />
                  <TextField label={t('settleLabel')} hint={t('settleHint')} type="number" min={0} step={1} value={draft.settleSec} onChange={(e) => { set('settleSec', e.target.value) }} {...errorFor('settleSec')} />
                </div>
                <span className="tr-hint">{t('existingNote')}</span>
                <div className="tr-field-row">
                  <span className="tr-field-row__label">{t('siblingLabel')}</span>
                  <div className="tr-grid tr-grid--3">
                    <TextField label={t('siblingFile')} value={draft.sibFile} placeholder="metadata.json" onChange={(e) => { set('sibFile', e.target.value) }} spellCheck={false} />
                    <TextField label={t('siblingField')} value={draft.sibField} placeholder="status" onChange={(e) => { set('sibField', e.target.value) }} spellCheck={false} />
                    <TextField label={t('siblingEquals')} value={draft.sibEquals} placeholder="completed" onChange={(e) => { set('sibEquals', e.target.value) }} spellCheck={false} />
                  </div>
                  {errors.sibling !== undefined ? <span className="tr-error" role="alert">{t('errSibling')}</span> : <span className="tr-hint">{t('siblingHint')}</span>}
                </div>
              </>
            )}
            {draft.kind === 'composio' && state.hasComposio && (
              <ComposioFields
                t={t} slug={draft.slug} accountId={draft.connectedAccountId} instanceId={draft.instanceId} slugError={errorFor('slug').error}
                onChange={(patch) => {
                  setDraft((d) => ({ ...d, ...(patch.slug === undefined ? {} : { slug: patch.slug }), ...(patch.connectedAccountId === undefined ? {} : { connectedAccountId: patch.connectedAccountId }), ...(patch.instanceId === undefined ? {} : { instanceId: patch.instanceId }) }))
                  setErrors((e) => { const n = { ...e }; delete n.slug; return n })
                }}
              />
            )}
            {draft.kind === 'composio' && !state.hasComposio && (
              <div className="tr-grid">
                <TextField label={t('slugLabel')} hint={t('slugHint')} value={draft.slug} onChange={(e) => { set('slug', e.target.value.trim().toUpperCase()) }} spellCheck={false} {...errorFor('slug')} />
              </div>
            )}
          </div>
        </Card>
      </Section>

      {saved !== undefined && saved.source.kind === 'webhook'
        ? <WebhookCard t={t} automation={saved} origin={state.origin} secret={freshSecret} busy={busy} onRotate={rotate} />
        : draft.kind === 'webhook' && saved === undefined && <span className="tr-hint">{t('webhookAfterSave')}</span>}

      <Section title={t('sectionTarget')}>
        <Card padded>
          <div className="tr-form">
            <div className="tr-grid tr-grid--wide">
              <Select
                label={t('workspaceLabel')} hint={t('workspaceHint')} value={workspaceValue} options={workspaceOptions}
                onChange={(v) => { if (v === CUSTOM) setCustomCwd(true); else { setCustomCwd(false); set('cwd', v) } }}
              />
              {customCwd && <TextField label={t('cwdLabel')} value={draft.cwd} placeholder="/home/me/project" onChange={(e) => { set('cwd', e.target.value) }} spellCheck={false} {...errorFor('cwd')} />}
            </div>
            {!customCwd && errors.cwd !== undefined && <span className="tr-error" role="alert">{t('errRequired')}</span>}
            <div className="tr-field-row">
              <span className="tr-field-row__label">{t('modeLabel')}</span>
              <div className="tr-segment-wrap">
                <SegmentedControl id="tr-mode" label={t('modeLabel')} value={draft.mode} onChange={(v) => { set('mode', v) }} options={[{ value: 'new', label: t('modeNew') }, { value: 'reuse', label: t('modeReuse') }]} />
              </div>
              {draft.mode === 'reuse' && <span className="tr-hint">{t('modeReuseHint')}</span>}
            </div>
            <div className="tr-grid">
              <Select label={t('modelLabel')} value={modelValue} options={modelOptions} onChange={pickModel} {...(catalogError === undefined ? {} : { hint: t('modelCatalogFailed') })} />
              {draft.model !== null && showEffort && <Select label={t('effortLabel')} value={currentEffort ?? ''} options={effortOptions} onChange={pickEffort} />}
            </div>
            <div className="tr-grid tr-grid--wide">
              <div className="tr-field-row">
                <span className="tr-field-row__label">{t('sandboxLabel')}</span>
                <div className="tr-segment-wrap">
                  <SegmentedControl id="tr-sandbox" label={t('sandboxLabel')} value={draft.sandbox} onChange={(v) => { set('sandbox', v) }} options={[{ value: 'read-only', label: t('sandboxReadOnly') }, { value: 'workspace-write', label: t('sandboxWrite') }]} />
                </div>
              </div>
              <div className="tr-field-row">
                <span className="tr-field-row__label">{t('toolsLabel')}</span>
                <div className="tr-segment-wrap">
                  <SegmentedControl id="tr-tools" label={t('toolsLabel')} value={draft.tools} onChange={(v) => { set('tools', v) }} options={[{ value: 'read', label: t('toolsRead') }, { value: 'standard', label: t('toolsStandard') }]} />
                </div>
              </div>
            </div>
            <span className="tr-hint">{t('toolsHint')}</span>
            <TextField label={t('titleLabel')} hint={t('titleHint')} value={draft.title} onChange={(e) => { set('title', e.target.value) }} spellCheck={false} />
          </div>
        </Card>
      </Section>

      <Section title={t('sectionPrompt')}>
        <Card padded>
          <div className="tr-form">
            <TextArea label={t('promptLabel')} hint={t('promptHint')} mono rows={16} value={draft.prompt} onChange={(e) => { set('prompt', e.target.value) }} spellCheck={false} {...errorFor('prompt')} />
            <details className="tr-vars">
              <summary>{t('varsToggle')}</summary>
              <dl>
                <dt>{'{{event_fenced}}'}</dt><dd>{t('varEventFenced')}</dd>
                <dt>{'{{event.<field>}}'}</dt><dd>{t('varEventField')}</dd>
                <dt>{'{{file.path}}'}</dt><dd>{t('varFilePath')}</dd>
                <dt>{'{{file.dirname}}'}</dt><dd>{t('varFileDirname')}</dd>
                <dt>{'{{file.name}}'}</dt><dd>{t('varFileName')}</dd>
                <dt>{'{{file.dir}}'}</dt><dd>{t('varFileDir')}</dd>
                <dt>{'{{received_at}}'}</dt><dd>{t('varReceivedAt')}</dd>
                <dt>{'{{automation}}'}</dt><dd>{t('varAutomation')}</dd>
              </dl>
            </details>
          </div>
        </Card>
      </Section>

      <Section title={t('sectionLimits')}>
        <Card padded>
          <div className="tr-grid">
            <TextField label={t('maxPerHourLabel')} type="number" min={1} step={1} value={draft.maxPerHour} onChange={(e) => { set('maxPerHour', e.target.value) }} {...errorFor('maxPerHour')} />
            <TextField label={t('minIntervalLabel')} type="number" min={0} step={1} value={draft.minIntervalSec} onChange={(e) => { set('minIntervalSec', e.target.value) }} {...errorFor('minIntervalSec')} />
          </div>
        </Card>
      </Section>

      <div className="tr-actions tr-actions--end">
        <Button variant="primary" disabled={busy || !dirty} onClick={() => { void save() }}>{busy ? t('saving') : saved === undefined ? t('create') : t('save')}</Button>
      </div>

      {saved !== undefined && (
        <Section title={t('runsTitle')}>
          <RunsTable t={t} runs={runs ?? state.runs.filter((r) => r.automationId === saved.id)} openSession={openSession} showAutomation={false} />
        </Section>
      )}

      <Modal
        open={preview !== undefined} onClose={() => { setPreview(undefined) }} title={t('previewTitle')} description={t('previewDescription')} closeLabel={t('close')} className="tr-modal-wide"
        footer={<Button variant="primary" data-modal-autofocus onClick={() => { setPreview(undefined) }}>{t('close')}</Button>}
      >
        {preview !== undefined && (
          <div className="tr-form">
            <div className="tr-field-row">
              <span className="tr-field-row__label">{t('previewChatTitle')}</span>
              <span className="tr-mono">{preview.title}</span>
            </div>
            <pre className="tr-preview" data-testid="preview-text">{preview.prompt}</pre>
          </div>
        )}
      </Modal>

      <Modal
        open={confirmDelete} onClose={() => { setConfirmDelete(false) }} title={t('deleteTitle')} description={t('deleteDescription', { name: saved?.name ?? '' })} closeLabel={t('close')}
        footer={<>
          <Button onClick={() => { setConfirmDelete(false) }}>{t('cancel')}</Button>
          <Button variant="danger" data-modal-autofocus disabled={busy} onClick={() => { void remove() }}>{t('delete')}</Button>
        </>}
      />
    </>
  )
}

function BackIcon() {
  return (
    <svg width={16} height={16} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M10 3.5L5.5 8l4.5 4.5" />
    </svg>
  )
}
