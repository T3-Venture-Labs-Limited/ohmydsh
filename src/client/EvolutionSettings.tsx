import { useCallback, useEffect, useState } from 'react'
import { Button, Card, SettingsRow, Switch, TextField } from '../kit/index.ts'
import { call, type ConfigResult, type EvolutionConfig, type ReviewStateResult } from './api.ts'
import { relativeTime } from './helpers.ts'
import type { T } from './locale.ts'

export function EvolutionSettings({ t }: { t: T }) {
  const [cfg, setCfg] = useState<ConfigResult | undefined>()
  const [review, setReview] = useState<ReviewStateResult | undefined>()
  const [msg, setMsg] = useState<string | undefined>()
  const [busy, setBusy] = useState(false)
  const [scope, setScope] = useState('')
  const load = useCallback(async () => {
    try { setCfg(await call<ConfigResult>('config')); setReview(await call<ReviewStateResult>('review-state')) } catch (e) { setMsg(e instanceof Error ? e.message : String(e)) }
  }, [])
  useEffect(() => { void load() }, [load])
  const patch = async (p: Partial<{ propose: Partial<EvolutionConfig['propose']>; reviewer: Partial<EvolutionConfig['reviewer']> }>): Promise<void> => {
    try { const r = await call<{ config: EvolutionConfig }>('config-set', { config: p }); setCfg(cfg === undefined ? cfg : { ...cfg, config: r.config }) } catch (e) { setMsg(e instanceof Error ? e.message : String(e)) }
  }
  const runNow = async (): Promise<void> => {
    setBusy(true); setMsg(undefined)
    try { const r = await call<{ run: { sessionsReviewed: number; proposals: number; status: string; errors: string[] } }>('review-run', scope.trim() === '' ? {} : { cwdPrefix: scope.trim() }); setMsg(t('runDone', { sessions: r.run.sessionsReviewed, proposals: r.run.proposals, status: r.run.status })); await load() } catch (e) { setMsg(e instanceof Error ? e.message : String(e)) } finally { setBusy(false) }
  }
  if (cfg === undefined) return <div className="ss-center" role="status">{t('loading')}</div>
  const c = cfg.config
  const route = `${cfg.route.provider}/${cfg.route.model}${cfg.route.effort === undefined ? '' : ` · ${cfg.route.effort}`}`
  return (
    <div className="ss-proposals" data-testid="ss-evolution-settings">
      <Card>
        <SettingsRow title={t('proposeEnable')} description={t('proposeEnableDescription')}>
          <Switch checked={c.propose.enabled} label={t('proposeEnable')} onChange={(v) => { void patch({ propose: { enabled: v } }) }} />
        </SettingsRow>
        <SettingsRow title={t('reviewerEnable')} description={t('reviewerEnableDescription', { route })}>
          <Switch checked={c.reviewer.enabled} label={t('reviewerEnable')} onChange={(v) => { void patch({ reviewer: { enabled: v } }) }} />
        </SettingsRow>
        <SettingsRow title={t('reviewerModel')} description={cfg.automation ? t('reviewerModelAutomation') : t('reviewerModelOwn')}>
          <span className="ss-mono ss-note">{route}</span>
        </SettingsRow>
      </Card>
      {!cfg.automation && (
        <Card padded>
          <div className="ss-form">
            <TextField label={t('reviewerProvider')} value={c.reviewer.provider} onChange={(e) => { void patch({ reviewer: { provider: e.target.value } }) }} />
            <TextField label={t('reviewerModelId')} value={c.reviewer.model} onChange={(e) => { void patch({ reviewer: { model: e.target.value } }) }} />
          </div>
        </Card>
      )}
      <Card padded>
        <p className="ss-note" style={{ marginBottom: 12 }}>{t('limitsDescription')}</p>
        <div className="ss-toolbar">
          {([['minUserTurns', 'limitMinTurns'], ['minToolCalls', 'limitMinCalls'], ['maxSessionsPerRun', 'limitMaxSessions']] as const).map(([key, label]) => (
            <TextField key={key} label={t(label)} type="number" min={key === 'maxSessionsPerRun' ? 1 : 0} value={String(c.reviewer[key])}
              onChange={(e) => { const n = Number(e.target.value); if (Number.isFinite(n)) void patch({ reviewer: { [key]: n } }) }} />
          ))}
        </div>
      </Card>
      <Card>
        <SettingsRow title={t('privacyTitle')} description={t('privacyDescription')}>{null}</SettingsRow>
        <SettingsRow title={t('budgetTitle')} description={t('budgetDescription', { used: review?.tokensToday ?? 0, limit: c.reviewer.maxTokensPerDay })}>
          <div className="ss-actions">
            <TextField label={t('reviewScope')} hideLabel placeholder={t('reviewScopePlaceholder')} value={scope} onChange={(e) => { setScope(e.target.value) }} />
            <Button size="sm" variant="primary" disabled={busy || review?.running === true} onClick={() => { void runNow() }}>{busy ? t('reviewing') : t('reviewNow')}</Button>
          </div>
        </SettingsRow>
      </Card>
      {msg !== undefined && <div className="ss-banner" role="status">{msg}</div>}
      <section>
        <h3 className="ss-section-title">{t('runLog')}</h3>
        {(review?.runs.length ?? 0) === 0 ? <p className="ss-note">{t('noRuns')}</p> : (
          <ul className="ss-issues" data-testid="ss-runlog">
            {review!.runs.slice(0, 8).map(r => (
              <li key={r.id} className="ss-issue ss-note">{`${relativeTime(r.finishedAt)} · ${r.trigger} · ${r.route} · ${String(r.sessionsReviewed)}/${String(r.sessionsConsidered)} sessions · ${String(r.proposals)} proposals · ${String(r.tokens)} tokens · ${r.status}${r.reviewed.length > 0 ? ` · ${r.reviewed.map(id => id.slice(-6)).join(', ')}` : ''}${r.errors.length > 0 ? ` · ${r.errors[0] ?? ''}` : ''}`}{(r.notes ?? []).map((n, i) => <span key={i} style={{ display: 'block' }}>{n}</span>)}</li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}
