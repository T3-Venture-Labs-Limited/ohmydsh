// The "Automation models" page (lazy chunk). Only dsh-kit controls and --dsw-* tokens; text goes through `t`.
import { useCallback, useEffect, useRef, useState } from 'react'
import { Button, Card, EmptyState, Page, Section, Select, SettingsRow, Switch } from '../kit/index.ts'
import type { SelectOption } from '../kit/index.ts'
import { call } from './api.ts'
import type { CatalogGroup, Mode, Route, State } from './api.ts'
import type { T } from './locale.ts'

const SESSION = '__session__'
const INHERIT = '__inherit__'
const routeLabel = (route: Route): string => `${route.provider}/${route.model}${route.reasoningEffort === undefined ? '' : ` (${route.reasoningEffort})`}`

interface PickerProps {
  t: T
  groups: CatalogGroup[]
  mode: Mode
  route: Route | null
  inheritLabel: string
  disabled: boolean
  onChange: (mode: Mode, route: Route | null) => void
}

/** Three native selects: where (inherit / session model / provider), which model of that provider, how much effort. A
 *  provider with hundreds of models (OpenRouter) stays usable because only its own list is rendered. */
function ModelPicker({ t, groups, mode, route, inheritLabel, disabled, onChange }: PickerProps) {
  const where = mode === 'inherit' ? INHERIT : mode === 'session' ? SESSION : route?.provider ?? INHERIT
  const group = route === null ? undefined : groups.find((g) => g.id === route.provider)
  const info = group?.models.find((m) => m.id === route?.model)
  const efforts = info?.efforts ?? []
  const pickWhere = (next: string): void => {
    if (next === INHERIT) { onChange('inherit', null); return }
    if (next === SESSION) { onChange('session', null); return }
    const first = groups.find((g) => g.id === next)?.models[0]
    if (first === undefined) return
    onChange('route', { provider: next, model: first.id, ...(first.efforts.some((e) => e.id === 'low') ? { reasoningEffort: 'low' } : {}) })
  }
  const pickModel = (id: string): void => {
    if (route === null) return
    const next = group?.models.find((m) => m.id === id)
    const keepEffort = route.reasoningEffort !== undefined && next?.efforts.some((e) => e.id === route.reasoningEffort) === true
    const effort = keepEffort ? route.reasoningEffort : next?.efforts.some((e) => e.id === 'low') === true ? 'low' : undefined
    onChange('route', { provider: route.provider, model: id, ...(effort === undefined ? {} : { reasoningEffort: effort }) })
  }
  const modelOptions: SelectOption[] = group?.models.map((m) => ({ value: m.id, label: m.name })) ?? []
  // A stored route the catalog no longer lists stays visible so the user can see and replace it.
  if (route !== null && info === undefined) modelOptions.unshift({ value: route.model, label: `${route.model} (unavailable)` })
  const whereOptions: SelectOption[] = [{ value: INHERIT, label: inheritLabel }, { value: SESSION, label: t('optSession') }, ...groups.map((g) => ({ value: g.id, label: g.name }))]
  if (route !== null && group === undefined) whereOptions.push({ value: route.provider, label: `${route.provider} (unavailable)` })
  return (
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
      <Select label={t('providerLabel')} hideLabel disabled={disabled} value={where} onChange={pickWhere} options={whereOptions} />
      {mode === 'route' && route !== null && (
        <Select label={t('modelLabel')} hideLabel disabled={disabled} value={route.model} onChange={pickModel} options={modelOptions} />
      )}
      {mode === 'route' && route !== null && efforts.length > 0 && (
        <Select
          label={t('effortLabel')} hideLabel disabled={disabled}
          value={route.reasoningEffort ?? ''}
          onChange={(effort) => { onChange('route', { provider: route.provider, model: route.model, ...(effort === '' ? {} : { reasoningEffort: effort }) }) }}
          options={[{ value: '', label: t('effortDefault') }, ...efforts.map((e) => ({ value: e.id, label: e.name }))]}
        />
      )}
    </div>
  )
}

const statusKey = (status: string): 'statusActive' | 'statusPaused' | 'statusEnded' => (status === 'paused' ? 'statusPaused' : status === 'ended' ? 'statusEnded' : 'statusActive')
const targetKey = (target: string): 'targetNew' | 'targetNewOnce' | 'targetSession' => (target === 'new' ? 'targetNew' : target === 'new_once' ? 'targetNewOnce' : 'targetSession')

export default function Panel({ t }: { t: T }) {
  const [state, setState] = useState<State | undefined>()
  const [error, setError] = useState<string | undefined>()
  const [busy, setBusy] = useState(false)
  const mounted = useRef(true)

  const run = useCallback(async (method: string, body: Record<string, unknown> = {}): Promise<void> => {
    setBusy(true)
    try { const next = await call<State>(method, body); if (mounted.current) { setState(next); setError(undefined) } }
    catch (e) { if (mounted.current) setError(e instanceof Error ? e.message : String(e)) }
    finally { if (mounted.current) setBusy(false) }
  }, [])

  useEffect(() => {
    mounted.current = true
    void run('state')
    // Push-free host: refresh when the tab becomes visible again instead of polling.
    const onVisible = (): void => { if (document.visibilityState === 'visible') void run('state') }
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('focus', onVisible)
    return () => { mounted.current = false; document.removeEventListener('visibilitychange', onVisible); window.removeEventListener('focus', onVisible) }
  }, [run])

  if (state === undefined) {
    return error === undefined
      ? <Page title={t('pageTitle')}><div role="status" style={{ color: 'var(--dsw-alias-label-secondary)' }}>{t('loading')}</div></Page>
      : <Page title={t('pageTitle')}><EmptyState tone="error" title={t('loadFailed')} description={error} actions={<Button variant="outline" size="sm" onClick={() => { void run('state') }}>{t('retry')}</Button>} /></Page>
  }

  const groups = state.catalog?.groups ?? []
  const sourceById = new Map(state.sources.map((s) => [s.kind, s]))
  const scheduleSource = sourceById.get('schedule')

  const setDefault = (kind: string, mode: Mode, route: Route | null): void => {
    void run('setDefault', mode === 'inherit' ? { kind } : { kind, route: mode === 'session' ? null : route })
  }
  const setOverride = (id: string, mode: Mode, route: Route | null, keep: boolean): void => {
    void run('setOverride', mode === 'inherit' ? { kind: 'schedule', key: id } : { kind: 'schedule', key: id, route: mode === 'session' ? null : route, keep })
  }

  return (
    <Page title={t('pageTitle')} description={t('pageDescription')}>
      {error !== undefined && <div role="alert" style={{ color: 'var(--dsw-alias-state-error-primary)' }}>{t('saveFailed', { message: error })}</div>}
      <Section>
        <Card>
          <SettingsRow title={t('enabledTitle')} description={t('enabledDescription')}>
            <Switch checked={state.enabled} disabled={busy || !state.ready} label={t('enabledTitle')} onChange={(enabled) => { void run('setEnabled', { enabled }) }} />
            <Button variant="outline" size="sm" disabled={busy} onClick={() => { void run('state') }}>{t('refresh')}</Button>
          </SettingsRow>
        </Card>
      </Section>
      <Section title={t('sectionDefaults')} description={t('sectionDefaultsDescription')}>
        <Card>
          {state.sources.map((source) => (
            <SettingsRow
              key={source.kind}
              title={source.label}
              description={source.stored === 'session' ? t('effectiveSession') : source.effective === null ? t('effectiveSession') : source.effectiveAvailable ? t('effective', { route: routeLabel(source.effective) }) : t('unavailable')}
            >
              <ModelPicker
                t={t} groups={groups} disabled={busy || !state.enabled || groups.length === 0}
                mode={source.stored} route={source.route} inheritLabel={t('optInheritDefault')}
                onChange={(mode, route) => { setDefault(source.kind, mode, route) }}
              />
            </SettingsRow>
          ))}
        </Card>
        {state.catalog === null && <p style={{ color: 'var(--dsw-alias-label-secondary)' }}>{t('noCatalog')}</p>}
      </Section>
      <Section title={t('sectionTasks')} description={t('sectionTasksDescription')}>
        {state.tasks.length === 0
          ? <EmptyState title={t('noTasks')} description={t('noTasksDescription')} />
          : (
            <Card>
              {state.tasks.map((task) => (
                <SettingsRow key={task.id} title={task.title} description={`${t(statusKey(task.status))} · ${task.timing} · ${t(targetKey(task.target))}`}>
                  <ModelPicker
                    t={t} groups={groups} disabled={busy || !state.enabled || groups.length === 0}
                    mode={task.override} route={task.route}
                    inheritLabel={`${t('optInherit')}${scheduleSource?.effective == null ? '' : ` (${routeLabel(scheduleSource.effective)})`}`}
                    onChange={(mode, route) => { setOverride(task.id, mode, route, task.keep) }}
                  />
                  {task.override === 'route' && (
                    <Switch checked={task.keep} disabled={busy} label={t('keepLabel')} onChange={(keep) => { setOverride(task.id, 'route', task.route, keep) }} />
                  )}
                </SettingsRow>
              ))}
            </Card>
          )}
      </Section>
      <Section title={t('notices')}>
        {state.notices.length === 0
          ? <p style={{ color: 'var(--dsw-alias-label-secondary)' }}>{t('noticesEmpty')}</p>
          : (
            <Card padded>
              <ul style={{ margin: 0, paddingLeft: 18 }}>
                {[...state.notices].reverse().map((n) => (
                  <li key={`${String(n.at)}-${n.text}`} style={{ color: n.level === 'warn' ? 'var(--dsw-alias-state-warn-primary)' : 'var(--dsw-alias-label-primary)' }}>
                    {new Date(n.at).toLocaleTimeString()} {n.text}
                  </li>
                ))}
              </ul>
            </Card>
          )}
      </Section>
    </Page>
  )
}
