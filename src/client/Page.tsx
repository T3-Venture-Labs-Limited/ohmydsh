import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Button, EmptyState, Select, TextField } from '../kit/index.ts'
import { call, type StateResult, type SkillRow } from './api.ts'
import { CreateModal } from './CreateModal.tsx'
import { Detail, type DetailServices } from './Detail.tsx'
import { matches, sourceLabel, type Filter } from './helpers.ts'
import type { T } from './locale.ts'
import { SkillListRow } from './Row.tsx'
import { ProposalsTab } from './ProposalsTab.tsx'
import { EvolutionSettings } from './EvolutionSettings.tsx'
import { SegmentedControl } from '../kit/index.ts'
import { useStudioStyles } from './styles.ts'
import { useKitStyles } from '../kit/styles.ts'

export interface PageServices {
  /** Workspace paths the user has, plus the current conversation's working directory when known. */
  currentCwd: () => string | undefined
  openInSidebar: (path: string, title: string) => boolean
  /** Subscribe to visibility/focus-driven refresh triggers; returns the disposer. */
  onFocus: (listener: () => void) => () => void
  /** Push-fed pending count (SSE owned by the entry); a hook so the page re-renders on change. */
  useSummary: () => import('./api.ts').Summary
  subscribeSummary: (listener: () => void) => () => void
}

const FILTERS: { value: Filter; key: 'filterAll' | 'filterEnabled' | 'filterDisabled' | 'filterIssues' }[] = [
  { value: 'all', key: 'filterAll' }, { value: 'enabled', key: 'filterEnabled' }, { value: 'disabled', key: 'filterDisabled' }, { value: 'issues', key: 'filterIssues' },
]

export function SkillsPage({ t, services }: { t: T; services: PageServices }) {
  useKitStyles()
  useStudioStyles()
  const [state, setState] = useState<StateResult | undefined>()
  const [error, setError] = useState<string | undefined>()
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<Filter>('all')
  const [source, setSource] = useState('all')
  const [workspace, setWorkspace] = useState<string>('')
  const [selected, setSelected] = useState<string | undefined>()
  const [busy, setBusy] = useState<string | undefined>()
  const [toast, setToast] = useState<{ tone: 'error' | 'success'; text: string } | undefined>()
  const [creating, setCreating] = useState(false)
  const seq = useRef(0)
  const [tab, setTab] = useState<'skills' | 'proposals' | 'reviewer'>('skills')
  const summary = services.useSummary()

  const cwd = workspace === '' ? undefined : workspace

  const refresh = useCallback(async () => {
    const mine = ++seq.current
    try {
      const next = await call<StateResult>('state', cwd === undefined ? {} : { workspace: cwd })
      if (mine !== seq.current) return
      setState(next); setError(undefined)
    } catch (e) { if (mine === seq.current) setError(e instanceof Error ? e.message : String(e)) }
  }, [cwd])

  useEffect(() => { void refresh() }, [refresh])
  // Disk edits from outside (another editor, another agent) and plugin-manager changes: refresh on focus, never on a timer.
  useEffect(() => services.onFocus(() => { void refresh() }), [services, refresh])
  // Usage needs a scan of every session log; load it after first paint and merge.
  // Asked once per page visit (and on Rescan): without a session-history service the host answers `available: false`
  // and the state never becomes cached, so this must not depend on `state` or it would loop.
  const usageAsked = useRef(false)
  const askUsage = useCallback((force: boolean) => {
    void call<{ available: boolean }>('usage', force ? { force: true } : {}).then(() => refresh()).catch(() => undefined)
  }, [refresh])
  const loaded = state !== undefined
  useEffect(() => {
    if (!loaded || usageAsked.current) return
    usageAsked.current = true
    const timer = window.setTimeout(() => { askUsage(false) }, 400)
    return () => { window.clearTimeout(timer) }
  }, [loaded, askUsage])

  const rows = state?.rows ?? []
  const visible = useMemo(() => rows.filter(r => matches(r, query, filter, source)), [rows, query, filter, source])
  const current = rows.find(r => r.id === selected)
  const counts = useMemo(() => ({
    total: rows.filter(r => r.state === 'active').length,
    disabled: rows.filter(r => r.state === 'active' && (r.disabled === 'disabled-global' || r.disabled === 'disabled-workspace')).length,
    shadowed: rows.filter(r => r.state === 'shadowed').length,
    invalid: rows.filter(r => r.state === 'invalid').length,
  }), [rows])
  const sources = useMemo(() => [...new Set(rows.map(r => r.source))].sort(), [rows])

  const toggle = useCallback(async (row: SkillRow, hide: boolean) => {
    setBusy(row.id); setToast(undefined)
    try {
      await call('toggle', { name: row.name, hide, scope: cwd === undefined ? 'global' : 'workspace', ...(cwd === undefined ? {} : { workspace: cwd }) })
      await refresh()
    } catch (e) { setToast({ tone: 'error', text: `${t('toggleFailed')}: ${e instanceof Error ? e.message : String(e)}` }) } finally { setBusy(undefined) }
  }, [cwd, refresh, t])

  const detailServices: DetailServices = useMemo(() => ({ openInSidebar: services.openInSidebar, workspace: cwd }), [services, cwd])
  const wsOptions = [{ value: '', label: t('workspaceGlobal') }, ...(state?.workspaces ?? []).map(w => ({ value: w.path, label: w.title }))]
  const wsName = (state?.workspaces ?? []).find(w => w.path === workspace)?.title

  return (
    <div className="ss-page" data-testid="skills-page">
      <header className="ss-head">
        <div>
          <h1 className="ss-title">{t('pageTitle')}</h1>
          <p className="ss-subtitle">{t('pageDescription')}</p>
        </div>
        <div className="ss-actions">
          <Button size="sm" onClick={() => { void refresh(); askUsage(true) }}>{t('rescan')}</Button>
          <Button variant="primary" size="sm" onClick={() => { setCreating(true) }}>{t('newSkill')}</Button>
        </div>
      </header>

      {state !== undefined && !state.filter.installed && (
        <div className="ss-banner" data-tone="warn">
          <strong>{t('filterOffTitle')}.</strong> {t('filterOffDescription', { reason: state.filter.reason ?? '—' })}
        </div>
      )}

      <SegmentedControl id="ss-tabs" label={t('tabsLabel')} value={tab} onChange={setTab} options={[
        { value: 'skills', label: t('tabSkills') },
        { value: 'proposals', label: summary.pending > 0 ? t('tabProposalsCount', { count: summary.pending }) : t('tabProposals') },
        { value: 'reviewer', label: t('tabReviewer') },
      ]} />

      {tab === 'proposals' && <ProposalsTab t={t} workspace={cwd} subscribe={services.subscribeSummary} />}
      {tab === 'reviewer' && <EvolutionSettings t={t} />}

      {tab === 'skills' && (<>
      <div className="ss-toolbar">
        <TextField className="ss-grow" label={t('search')} value={query} placeholder={t('searchPlaceholder')} onChange={(e) => { setQuery(e.target.value) }} />
        <Select label={t('filterLabel')} value={filter} onChange={(v) => { setFilter(v as Filter) }} options={FILTERS.map(f => ({ value: f.value, label: t(f.key) }))} />
        <Select label={t('sourceLabel')} value={source} onChange={setSource} options={[{ value: 'all', label: t('sourceAll') }, ...sources.map(s => ({ value: s, label: sourceLabel(t, s) }))]} />
        <Select label={t('workspaceLabel')} value={workspace} onChange={setWorkspace} options={wsOptions} />
      </div>
      <div className="ss-foot">
        <span className="ss-summary" role="status">{state === undefined ? t('loading') : t('summary', counts)}</span>
        {wsName !== undefined && <span className="ss-note">{t('workspaceHint', { name: wsName })}</span>}
        <span className="ss-note">{t('menuRefreshNote')}</span>
        {state !== undefined && !state.usage.cached && state.usage.sessionsScanned === 0 && <span className="ss-note">{t('usageLoading')}</span>}
        {state !== undefined && state.usage.cached && state.usage.sessionsScanned > 0 && <span className="ss-note">{t('usageScanned', { count: state.usage.sessionsScanned })}</span>}
      </div>
      {toast !== undefined && <div className="ss-banner" data-tone={toast.tone} role="alert">{toast.text}</div>}

      {error !== undefined && state === undefined ? (
        <EmptyState tone="error" title={t('loadError')} description={error} actions={<Button size="sm" onClick={() => { void refresh() }}>{t('retry')}</Button>} />
      ) : state === undefined ? (
        <div className="ss-center" role="status">{t('loading')}</div>
      ) : (
        <div className="ss-body" data-detail={current === undefined ? 'closed' : 'open'}>
          {visible.length === 0 ? (
            <EmptyState title={t('emptyTitle')} description={t('emptyDescription')} />
          ) : (
            <div className="ss-list" role="listbox" aria-label={t('pageTitle')}>
              {visible.map(row => (
                <SkillListRow key={row.id} row={row} t={t} selected={row.id === selected} busy={busy === row.id} workspaceScoped={cwd !== undefined}
                  onSelect={() => { setSelected(row.id === selected ? undefined : row.id) }} onToggle={(hide) => { void toggle(row, hide) }} />
              ))}
            </div>
          )}
          {current !== undefined && (
            <Detail key={current.id} row={current} t={t} services={detailServices} onClose={() => { setSelected(undefined) }} onChanged={() => { void refresh() }} />
          )}
        </div>
      )}

      </>)}

      <CreateModal open={creating} t={t} rows={rows} createRoots={state?.createRoots ?? {}} workspace={cwd} onClose={() => { setCreating(false) }}
        onCreated={(name, path) => { setCreating(false); setToast({ tone: 'success', text: t('createDone', { name }) + ` — ${path}` }); setSelected(path); void refresh() }} />
    </div>
  )
}
