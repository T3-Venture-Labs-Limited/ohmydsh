import { useMemo, useState } from 'react'
import { Button, Modal } from '../../kit/index.js'
import { api, fileUrl, thumbUrl } from './api.js'
import { assetCache, cacheAssets, toggleFavorite } from './gallery-data.js'
import { useWorkbench } from './ctx.js'
import { usd } from './format.js'
import { t, type Key } from './i18n.js'
import { IconRefresh, IconStop } from './icons.js'
import { dismissJobs, labelOf, liveStore, sortedJobs, upsertJob, useLive } from './live.js'
import { createStore, useStore } from './store.js'
import { errorText } from './ui.js'
import type { ComposerPrefill } from '../studio-bus.js'
import { isActive, type AssetRecord, type JobView } from './types.js'

const STATE_KEY: Record<string, Key> = {
  queued: 'stateQueued', submitting: 'stateSubmitting', running: 'stateRunning', finalizing: 'stateFinalizing',
  succeeded: 'stateSucceeded', failed: 'stateFailed', canceled: 'stateCanceled', needs_attention: 'stateNeedsAttention',
}

/** Compare groups: jobs submitted together so results can be shown side by side. */
const groups = createStore<Record<string, string[]>>({})
export function registerCompareGroup(id: string, jobIds: string[]): void { groups.set(prev => ({ ...prev, [id]: jobIds })) }

export function JobCard({ job, onOpenRequest, onAsset }: { job: JobView; onOpenRequest: (p: ComposerPrefill) => void; onAsset: (id: string) => void }) {
  const wb = useWorkbench()
  const active = isActive(job.state)
  const tone = job.state === 'succeeded' ? 'ok' : job.state === 'failed' ? 'err' : job.state === 'needs_attention' ? 'warn' : undefined
  const cancel = async (): Promise<void> => { try { upsertJob((await api.cancel(job.id)).job) } catch (e) { wb.toast(errorText(e), 'err') } }
  const retry = async (): Promise<void> => { try { upsertJob((await api.retry(job.id)).job) } catch (e) { wb.toast(errorText(e), 'err') } }
  const reopen = async (): Promise<void> => {
    try {
      const { request } = await api.job(job.id)
      onOpenRequest({
        op: request.op === 'inpaint' ? 'edit' : request.op, modelId: request.modelId,
        ...(request.prompt === undefined ? {} : { prompt: request.prompt }), ...(request.negativePrompt === undefined ? {} : { negativePrompt: request.negativePrompt }),
        params: { ...request.params },
        ...(request.inputs.source === undefined ? {} : { source: request.inputs.source.assetId }),
        ...(request.inputs.references === undefined ? {} : { references: request.inputs.references.map(r => r.assetId) }),
        ...(request.inputs.firstFrame === undefined ? {} : { firstFrame: request.inputs.firstFrame.assetId }),
        ...(request.inputs.lastFrame === undefined ? {} : { lastFrame: request.inputs.lastFrame.assetId }),
        ...(request.inputs.video === undefined ? {} : { video: request.inputs.video.assetId }),
      })
    } catch (e) { wb.toast(errorText(e), 'err') }
  }
  const pct = job.progress === undefined ? undefined : Math.round(job.progress * 100)
  return (
    <div className="st-job" data-state={job.state}>
      <div className="st-row">
        <span className="st-badge" data-tone={tone}>{t(STATE_KEY[job.state] ?? 'stateQueued')}{active && pct !== undefined ? ` ${String(pct)}%` : ''}</span>
        <span className="st-grow st-small st-muted" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={job.prompt}>{labelOf(job.modelId)}{job.prompt !== undefined && job.prompt !== '' ? ` · ${job.prompt}` : ''}</span>
        <span className="st-small st-dim">{job.costUsd !== undefined ? t('costShort', { usd: usd(job.costUsd) }) : job.estimateUsd !== undefined ? t('estShort', { usd: usd(job.estimateUsd) }) : ''}</span>
      </div>
      {active && <div className={`st-bar ${pct === undefined ? 'st-bar--indeterminate' : ''}`} role="progressbar" aria-valuemin={0} aria-valuemax={100} {...(pct === undefined ? {} : { 'aria-valuenow': pct })}><span style={{ width: `${String(pct ?? 0)}%` }} /></div>}
      {active && job.message !== undefined && <span className="st-small st-dim">{job.message}</span>}
      {job.state === 'needs_attention' && <p className="st-warn">{job.error?.message ?? t('needsAttention')} {t('needsAttention')}</p>}
      {job.state === 'failed' && job.error !== undefined && <p className="st-error">{job.error.message}</p>}
      {job.assetIds.length > 0 && (
        <div className="st-job__thumbs">{job.assetIds.slice(0, 6).map(id => <button key={id} type="button" aria-label={t('openItem')} onClick={() => { onAsset(id) }}><img src={thumbUrl(id, 96)} alt="" loading="lazy" /></button>)}</div>
      )}
      <div className="st-row st-row--wrap">
        {active && <Button size="sm" icon={<IconStop size={12} />} onClick={() => { void cancel() }}>{t('cancelJob')}</Button>}
        {(job.state === 'failed' || job.state === 'canceled' || job.state === 'needs_attention') && <Button size="sm" icon={<IconRefresh size={12} />} onClick={() => { void retry() }}>{t('retry')}</Button>}
        {!active && <Button size="sm" variant="ghost" onClick={() => { void reopen() }}>{t('openRequest')}</Button>}
        {!active && <Button size="sm" variant="ghost" onClick={() => { dismissJobs([job.id]) }}>{t('dismiss')}</Button>}
      </div>
    </div>
  )
}

export function JobsTray({ compact, onOpenRequest, limit = 8 }: { compact?: boolean; onOpenRequest: (p: ComposerPrefill) => void; limit?: number }) {
  const wb = useWorkbench()
  const { jobs, connected, loaded } = useLive()
  const grouped = useStore(groups, s => s)
  const [compareOpen, setCompareOpen] = useState<string[] | undefined>()
  const list = useMemo(() => sortedJobs(jobs), [jobs])
  const shown = list.slice(0, compact ? Math.min(limit, 5) : limit)
  const finished = list.filter(j => !isActive(j.state) && j.state !== 'needs_attention').map(j => j.id)
  const groupEntries = Object.entries(grouped).filter(([, ids]) => ids.every(id => jobs[id] !== undefined))
  return (
    <section className="st-col" style={{ gap: 8 }} aria-label={t('jobs')}>
      <div className="st-row">
        <h3 className="st-section-title st-grow">{t('jobs')}</h3>
        <span className="st-small st-dim st-row" style={{ gap: 4 }}><span className="st-live-dot" data-on={connected} />{connected ? t('live') : t('offline')}</span>
        {finished.length > 0 && <button type="button" className="st-link st-small" onClick={() => { dismissJobs(finished) }}>{t('clearFinished')}</button>}
      </div>
      {groupEntries.map(([gid, ids]) => {
        const done = ids.every(id => jobs[id] !== undefined && !isActive(jobs[id]!.state))
        return done || ids.some(id => jobs[id]?.state === 'succeeded')
          ? <div key={gid} className="st-row st-small"><span className="st-grow">{t('compareGroup', { n: ids.length })}</span><Button size="sm" disabled={!done} onClick={() => { setCompareOpen(ids) }}>{t('openCompare')}</Button></div>
          : null
      })}
      {!loaded && <div className="st-skeleton" style={{ height: 48, borderRadius: 8 }} />}
      {loaded && shown.length === 0 && <p className="st-muted st-small">{t('noJobs')}</p>}
      <div className="st-jobs">{shown.map(job => <JobCard key={job.id} job={job} onOpenRequest={onOpenRequest} onAsset={(id) => { wb.openAsset(id, job.assetIds) }} />)}</div>
      <CompareDialog ids={compareOpen} onClose={() => { setCompareOpen(undefined) }} />
    </section>
  )
}

function CompareDialog({ ids, onClose }: { ids: string[] | undefined; onClose: () => void }) {
  const jobs = useStore(liveStore, s => s.jobs)
  const cache = useStore(assetCache, s => s)
  const entries = (ids ?? []).map(id => jobs[id]).filter((j): j is JobView => j !== undefined)
  const assets: { job: JobView; asset: AssetRecord | undefined; id: string }[] = entries.map(job => ({ job, id: job.assetIds[0] ?? '', asset: cache[job.assetIds[0] ?? ''] }))
  const missing = assets.filter(a => a.id !== '' && a.asset === undefined).map(a => a.id)
  useMemo(() => { for (const id of missing) void api.asset(id).then(r => { cacheAssets([r.asset]) }, () => undefined) }, [missing.join(',')]) // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <Modal open={ids !== undefined} onClose={onClose} title={t('compareTitle')} closeLabel={t('close')}>
      <div className="st-compare-grid">
        {assets.map(({ job, asset, id }) => (
          <figure key={job.id}>
            {asset === undefined ? <div className="st-skeleton" style={{ aspectRatio: '1', borderRadius: 8 }} />
              : asset.kind === 'video' ? <video src={fileUrl(asset.id)} controls muted loop playsInline /> : <img src={fileUrl(asset.id)} alt={labelOf(job.modelId)} />}
            <figcaption className="st-row st-small"><b className="st-grow">{labelOf(job.modelId)}</b><span className="st-muted">{usd(job.costUsd ?? job.estimateUsd)}</span>
              {asset !== undefined && id !== '' && <Button size="sm" onClick={() => { void toggleFavorite(asset, (aid, p) => { cacheAssets([{ ...asset, ...p, id: aid }]) }) }}>{asset.favorite ? '★' : t('keepBest')}</Button>}
            </figcaption>
          </figure>
        ))}
      </div>
    </Modal>
  )
}

