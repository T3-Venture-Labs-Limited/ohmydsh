// Inline cards for studio_make / studio_job / studio_gallery results in the chat stream.
import { useEffect, useMemo, useState } from 'react'
import { Button } from '../../kit/index.js'
import { api } from './api.js'
import { assetCache, cacheAssets } from './gallery-data.js'
import { usd } from './format.js'
import { t } from './i18n.js'
import { liveStore, retainLive, useLive, labelOf } from './live.js'
import { useStore } from './store.js'
import { studioBus } from '../studio-bus.js'
import { KindBadge, MediaThumb } from './ui.js'
import { useStudioStyles } from './workbench.js'
import { isActive, type AssetRecord, type JobView } from './types.js'

export interface ToolCardData {
  toolName: string
  phase: 'preparing' | 'start' | 'result'
  /** Result text from the tool (contains job/asset ids). */
  text: string
  isError: boolean
  args: Record<string, unknown>
}

const JOB_ID = /\bjob_[0-9A-Za-z]{8,}\b/
const ASSET_ID = /\b[0-9A-HJKMNP-TV-Z]{26}\b/g

export function parseToolText(text: string): { jobId: string | undefined; assetIds: string[] } {
  const assetIds = [...new Set(text.match(ASSET_ID) ?? [])]
  return { jobId: JOB_ID.exec(text)?.[0], assetIds }
}

function Item({ asset, siblings }: { asset: AssetRecord; siblings: string[] }) {
  return (
    <div className="st-tool__item">
      <button type="button" className="st-tile" onClick={() => { studioBus.emit({ tab: 'gallery', assetId: asset.id }); void siblings }} aria-label={`${t('openInStudio')}: ${asset.prompt ?? asset.id}`}>
        <MediaThumb asset={asset} w={480} hoverPlay />
        {asset.kind === 'video' && <KindBadge asset={asset} />}
      </button>
    </div>
  )
}

export function StudioToolCard({ data }: { data: ToolCardData }) {
  useStudioStyles()
  const parsed = useMemo(() => parseToolText(data.text), [data.text])
  const jobId = parsed.jobId
  const jobs = useStore(liveStore, s => s.jobs)
  useLive()
  useEffect(() => retainLive(), [])
  const cache = useStore(assetCache, s => s)
  const [fetched, setFetched] = useState<Record<string, boolean>>({})
  const [job, setJob] = useState<JobView | undefined>()

  useEffect(() => {
    if (jobId === undefined || jobs[jobId] !== undefined) return
    void api.job(jobId).then(r => { setJob(r.job) }, () => undefined)
  }, [jobId, jobs])
  const liveJob = jobId === undefined ? undefined : jobs[jobId] ?? job
  const assetIds = useMemo(() => [...new Set([...(liveJob?.assetIds ?? []), ...parsed.assetIds])].slice(0, 12), [liveJob, parsed.assetIds])

  useEffect(() => {
    for (const id of assetIds) {
      if (cache[id] !== undefined || fetched[id]) continue
      setFetched(prev => ({ ...prev, [id]: true }))
      void api.asset(id).then(r => { cacheAssets([r.asset]) }, () => undefined)
    }
  }, [assetIds, cache, fetched])
  const assets = assetIds.map(id => cache[id]).filter((a): a is AssetRecord => a !== undefined && a.deletedAt === undefined)
  const active = liveJob !== undefined && isActive(liveJob.state)
  const pct = liveJob?.progress === undefined ? undefined : Math.round(liveJob.progress * 100)

  if (data.phase !== 'result') {
    return <div className="st-tool"><div className="st-bar st-bar--indeterminate" role="progressbar" aria-label={t('toolRunning')}><span /></div><span className="st-muted st-small">{t('toolRunning')}</span></div>
  }
  return (
    <div className="st-tool">
      {active && liveJob !== undefined && (
        <div className="st-job" data-state={liveJob.state}>
          <div className="st-row"><span className="st-badge">{liveJob.state}{pct === undefined ? '' : ` ${String(pct)}%`}</span><span className="st-grow st-small st-muted">{labelOf(liveJob.modelId)}</span>
            <span className="st-small st-dim">{liveJob.estimateUsd !== undefined ? t('estShort', { usd: usd(liveJob.estimateUsd) }) : ''}</span></div>
          <div className={`st-bar ${pct === undefined ? 'st-bar--indeterminate' : ''}`}><span style={{ width: `${String(pct ?? 0)}%` }} /></div>
          {liveJob.message !== undefined && <span className="st-small st-dim">{liveJob.message}</span>}
        </div>
      )}
      {!active && liveJob?.state === 'failed' && liveJob.error !== undefined && <p className="st-error">{liveJob.error.message}</p>}
      {assets.length > 0 && <div className="st-tool__grid">{assets.map(a => <Item key={a.id} asset={a} siblings={assetIds} />)}</div>}
      {assets.length === 0 && !active && !data.isError && data.toolName === 'studio_gallery' && <span className="st-muted st-small">{t('toolNoAssets')}</span>}
      <div className="st-row st-row--wrap st-small">
        {liveJob !== undefined && !active && liveJob.costUsd !== undefined && <span className="st-dim">{usd(liveJob.costUsd)} · {liveJob.costSource === 'provider' ? t('costProvider') : t('costEstimate')}</span>}
        <span className="st-grow" />
        {assets[0] !== undefined && (<>
          {assets[0].kind === 'image' && <Button size="sm" variant="ghost" onClick={() => { studioBus.emit({ tab: 'create', prefill: { kind: 'image', op: 'upscale', source: assets[0]!.id } }) }}>{t('upscale')}</Button>}
          {assets[0].kind === 'image' && <Button size="sm" variant="ghost" onClick={() => { studioBus.emit({ tab: 'create', prefill: { kind: 'video', op: 'animate', firstFrame: assets[0]!.id, ...(assets[0]!.prompt === undefined ? {} : { prompt: assets[0]!.prompt }) } }) }}>{t('animate')}</Button>}
          <Button size="sm" variant="ghost" onClick={() => { studioBus.emit({ tab: 'video', assetIds: [assets[0]!.id] }) }}>{t('openInHyperFrames')}</Button>
        </>)}
        <Button size="sm" variant="outline" onClick={() => { studioBus.emit({ tab: 'gallery', ...(assets[0] === undefined ? {} : { assetId: assets[0].id }) }) }}>{t('openInStudio')}</Button>
      </div>
    </div>
  )
}
