// The Triggers page (lazy chunk): header (Pause all, New automation), automation list, recent runs; a full-width
// detail / editor view per automation. dsh-kit controls and --dsw-* tokens only.
// The page root is a scroll container (triggers.css `.tr-scroll`): the host main panel clips its content.
// No idle polling: state is re-read on visibilitychange, after every mutation and from the Refresh button.
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Button, Card, EmptyState, Modal, Page, Section, Switch } from '../kit/index.ts'
import type { AutomationView, SaveRequest, SaveResponse, TriggersState } from '../shared/types.ts'
import { call, errorText } from './api.ts'
import type { Catalog } from './api.ts'
import { Editor } from './editor.tsx'
import type { T } from './locale.ts'
import { TEMPLATE_IDS, modelName, templateRequest } from './model.ts'
import type { TemplateId } from './model.ts'
import { RunsTable } from './runs.tsx'
import { useTriggersStyles } from './styles.ts'
import { Badge, Chip, RunBadge, TimeAgo, sourceLabel } from './ui.tsx'

type View = { kind: 'list' } | { kind: 'detail'; id: string } | { kind: 'new'; request: SaveRequest; key: number }

export interface PanelProps {
  t: T
  /** Navigate to a chat inside DSH (workspace UI service, or dsh-hud's hash fallback). */
  openSession: (sessionId: string) => void
}

/** Root of every state of the page: a vertically scrolling container filling the host panel, then the kit page. */
function Frame({ t, children, description = true }: { t: T; children?: ReactNode; description?: boolean }) {
  useTriggersStyles()
  const scroller = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = scroller.current
    if (el !== null && !el.contains(document.activeElement)) el.focus({ preventScroll: true })
  }, [])
  return (
    <div ref={scroller} className="tr-scroll" data-triggers-scroll="" tabIndex={-1}>
      <Page className="tr-page" title={t('pageTitle')} {...(description ? { description: t('pageDescription') } : {})}>{children}</Page>
    </div>
  )
}

export function templateNames(t: T): Record<TemplateId, string> {
  return { meeting: t('tplMeetingName'), webhook: t('tplWebhook'), github: t('tplGithub'), folder: t('tplFolder'), composio: t('tplComposio'), blank: '' }
}

function templateText(t: T, id: TemplateId): { name: string; hint: string } {
  switch (id) {
    case 'meeting': return { name: t('tplMeeting'), hint: t('tplMeetingHint') }
    case 'webhook': return { name: t('tplWebhook'), hint: t('tplWebhookHint') }
    case 'github': return { name: t('tplGithub'), hint: t('tplGithubHint') }
    case 'folder': return { name: t('tplFolder'), hint: t('tplFolderHint') }
    case 'composio': return { name: t('tplComposio'), hint: t('tplComposioHint') }
    case 'blank': return { name: t('tplBlank'), hint: t('tplBlankHint') }
  }
}

export function targetSummary(t: T, a: Pick<AutomationView, 'target'>, catalog: Catalog | null | undefined): string {
  const mode = a.target.mode === 'new' ? t('targetNew') : t('targetReuse')
  const model = a.target.model === null ? t('profileDefault') : modelName(a.target.model, catalog)
  const sandbox = a.target.sandbox === 'read-only' ? t('sandboxReadOnlyShort') : t('sandboxWriteShort')
  return [mode, model, sandbox].join(' · ')
}

export default function Panel({ t, openSession }: PanelProps) {
  const [state, setState] = useState<TriggersState | undefined>()
  const [error, setError] = useState<string | undefined>()
  const [busy, setBusy] = useState(false)
  const [view, setView] = useState<View>({ kind: 'list' })
  const [picker, setPicker] = useState(false)
  const [catalog, setCatalog] = useState<Catalog | null | undefined>()
  const [catalogError, setCatalogError] = useState<string | undefined>()
  /**
   * The last save / rotate response: its full secret (create / rotate only) and warnings, kept only while that
   * automation's detail stays open. Also bridges the gap between create and the refreshed state listing it.
   */
  const [last, setLast] = useState<SaveResponse | undefined>()
  const mounted = useRef(true)
  const seq = useRef(0)

  const apply = useCallback((next: TriggersState): void => { if (mounted.current) { setState(next); setError(undefined) } }, [])

  const run = useCallback(async (method: string, body: object = {}): Promise<void> => {
    const mine = ++seq.current
    setBusy(true)
    try {
      const next = await call<TriggersState>(method, body)
      // A slower, older `state` read must not overwrite the result of a newer mutation.
      if (mine === seq.current || method !== 'state') apply(next)
    } catch (e) { if (mounted.current) setError(errorText(e)) }
    finally { if (mounted.current && mine === seq.current) setBusy(false) }
  }, [apply])

  const refresh = useCallback(() => run('state'), [run])

  useEffect(() => {
    mounted.current = true
    void refresh()
    const onVisible = (): void => { if (document.visibilityState === 'visible') void refresh() }
    document.addEventListener('visibilitychange', onVisible)
    return () => { mounted.current = false; document.removeEventListener('visibilitychange', onVisible) }
  }, [refresh])

  // The model catalog is fetched once, the first time an editor opens (the list falls back to prettified ids).
  useEffect(() => {
    if (view.kind === 'list' || catalog !== undefined) return
    call<Catalog | null>('models').then((c) => { if (mounted.current) setCatalog(c) }).catch((e: unknown) => { if (mounted.current) { setCatalog(null); setCatalogError(errorText(e)) } })
  }, [view.kind, catalog])

  const goList = (): void => { setView({ kind: 'list' }); setLast(undefined) }
  const openDetail = (id: string): void => { setLast(undefined); setView({ kind: 'detail', id }) }
  const startTemplate = (id: TemplateId): void => {
    if (state === undefined) return
    setPicker(false)
    setLast(undefined)
    setView({ kind: 'new', request: templateRequest(id, state, templateNames(t)), key: Date.now() })
  }

  if (state === undefined) {
    return error === undefined
      ? <Frame t={t}><div role="status" className="tr-loading">{t('loading')}</div></Frame>
      : <Frame t={t}><EmptyState tone="error" title={t('loadFailed')} description={error} actions={<Button variant="outline" size="sm" onClick={() => { void refresh() }}>{t('retry')}</Button>} /></Frame>
  }

  const picked = view.kind === 'detail' ? state.automations.find((a) => a.id === view.id) ?? (last?.automation.id === view.id ? last.automation : undefined) : undefined
  const pickerModal = (
    <Modal open={picker} onClose={() => { setPicker(false) }} title={t('pickerTitle')} description={t('pickerDescription')} closeLabel={t('close')}>
      <div className="tr-templates" data-testid="template-picker">
        {TEMPLATE_IDS.map((id) => {
          const text = templateText(t, id)
          const off = id === 'composio' && !state.hasComposio
          return (
            <button key={id} type="button" className="tr-template" data-template={id} disabled={off} {...(id === 'meeting' ? { 'data-modal-autofocus': '' } : {})} onClick={() => { startTemplate(id) }}>
              <span className="tr-template__name">{text.name}</span>
              <span className="tr-template__hint">{off ? t('tplComposioMissing') : text.hint}</span>
            </button>
          )
        })}
      </div>
    </Modal>
  )

  if (view.kind === 'new' || picked !== undefined) {
    const initial = view.kind === 'new' ? view.request : picked as AutomationView
    const editorKey = view.kind === 'new' ? `new-${String(view.key)}` : `id-${(picked as AutomationView).id}`
    return (
      <Frame t={t} description={false}>
        {error !== undefined && <div role="alert" className="tr-error">{error}</div>}
        <Editor
          key={editorKey}
          t={t} state={state} initial={initial} catalog={catalog} catalogError={catalogError}
          freshSecret={picked !== undefined && last?.automation.id === picked.id ? last.secret : undefined}
          warnings={picked !== undefined && last?.automation.id === picked.id ? last.warnings : undefined}
          openSession={openSession}
          onBack={goList}
          refresh={refresh}
          onSaved={async (response: SaveResponse) => {
            const id = response.automation.id
            // Keep a secret from create / rotate visible across later saves of the same detail view.
            setLast((prev) => ({ ...response, ...(response.secret === undefined && prev?.automation.id === id && prev.secret !== undefined ? { secret: prev.secret } : {}) }))
            setView({ kind: 'detail', id })
            await refresh()
          }}
          onDeleted={(next) => { apply(next); goList() }}
        />
      </Frame>
    )
  }

  return (
    <Frame t={t}>
      <div className="tr-toolbar">
        <div className="tr-toolbar__group">
          <span className="tr-switch-label" title={t('pauseAllHint')}>
            <Switch checked={state.paused} disabled={busy} label={t('pauseAll')} onChange={(paused) => { void run('setPaused', { paused }) }} />
            {t('pauseAll')}
          </span>
        </div>
        <div className="tr-toolbar__group">
          <Button variant="outline" size="sm" disabled={busy} onClick={() => { void refresh() }}>{t('refresh')}</Button>
          <Button variant="primary" size="sm" onClick={() => { setPicker(true) }}>{t('newAutomation')}</Button>
        </div>
      </div>
      {state.paused && <div className="tr-banner" role="status">{t('pausedBanner')}</div>}
      {error !== undefined && <div role="alert" className="tr-error">{error}</div>}

      <Section title={t('listTitle')}>
        {state.automations.length === 0
          ? (
            <Card>
              <EmptyState
                title={t('emptyTitle')} description={t('emptyDescription')}
                actions={(
                  <div className="tr-empty-actions">
                    {TEMPLATE_IDS.map((id) => (
                      <Button key={id} variant={id === 'meeting' ? 'primary' : 'outline'} size="sm" disabled={id === 'composio' && !state.hasComposio}
                        title={id === 'composio' && !state.hasComposio ? t('tplComposioMissing') : templateText(t, id).hint} onClick={() => { startTemplate(id) }}>
                        {templateText(t, id).name}
                      </Button>
                    ))}
                  </div>
                )}
              />
            </Card>
          )
          : (
            <Card padded>
              <ul className="tr-list" style={{ margin: 0, padding: 0, listStyle: 'none' }}>
                {state.automations.map((a) => (
                  <li key={a.id} className="tr-item" data-automation={a.id}>
                    <button type="button" className="tr-item__open" aria-label={t('openDetail', { name: a.name })} onClick={() => { openDetail(a.id) }}>
                      <span className="tr-item__head">
                        <span className="tr-item__name">{a.name === '' ? t('untitled') : a.name}</span>
                        <Chip>{sourceLabel(t, a.source.kind)}</Chip>
                        {a.consecutiveFailures > 0 && <Badge tone="error">{a.consecutiveFailures === 1 ? t('failuresOne') : t('failures', { count: a.consecutiveFailures })}</Badge>}
                      </span>
                      <span className="tr-item__sub">{targetSummary(t, a, catalog)}</span>
                    </button>
                    <span className="tr-item__side">
                      {a.lastRun === null
                        ? <span className="tr-item__time">{t('neverRun')}</span>
                        : <><RunBadge t={t} status={a.lastRun.status} /><span className="tr-item__time"><TimeAgo t={t} at={a.lastRun.at} /></span></>}
                      <Switch checked={a.enabled} disabled={busy} label={t('enabledLabel', { name: a.name })} onChange={(enabled) => { void run('setEnabled', { id: a.id, enabled }) }} />
                    </span>
                  </li>
                ))}
              </ul>
            </Card>
          )}
      </Section>

      <Section title={t('runsTitle')}>
        <RunsTable t={t} runs={state.runs} openSession={openSession} />
      </Section>
      {pickerModal}
    </Frame>
  )
}
