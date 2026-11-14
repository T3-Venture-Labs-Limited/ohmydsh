// "Open in HyperFrames Studio": the host spawns `hyperframes preview` on 127.0.0.1; we embed it in an iframe when
// the page itself is on loopback, and otherwise show the address (nothing listens on the viewer's loopback).
import { useCallback, useEffect, useState } from 'react'
import { Button, EmptyState, TextField } from '../../kit/index.js'
import { ApiError, api } from './api.js'
import { useWorkbench } from './ctx.js'
import { assetCache, cacheAssets } from './gallery-data.js'
import { t } from './i18n.js'
import { IconExternal, IconLayers, IconRefresh, IconStop } from './icons.js'
import { CopyButton, errorText } from './ui.js'
import { useStore } from './store.js'
import type { HfStatus, HfOpen } from './types.js'

const isLoopbackPage = (): boolean => ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(location.hostname)

export function HyperFramesPane({ clipIds, onClipsConsumed }: { clipIds: string[] | undefined; onClipsConsumed: () => void }) {
  const wb = useWorkbench()
  const [status, setStatus] = useState<HfStatus | undefined>()
  const [current, setCurrent] = useState<HfOpen | undefined>()
  const [busy, setBusy] = useState<string | undefined>()
  const [error, setError] = useState<{ code: string; message: string } | undefined>()
  const [slug, setSlug] = useState('')
  const [pending, setPending] = useState<string[] | undefined>()
  const cache = useStore(assetCache, s => s)

  const refresh = useCallback(async () => {
    try { setStatus(await api.hf.status()) } catch (e) { setError({ code: 'status', message: errorText(e) }) }
  }, [])
  useEffect(() => { void refresh() }, [refresh])

  const open = useCallback(async (body: { assetIds?: string[]; project?: string }) => {
    setBusy(t('hfStarting')); setError(undefined)
    try {
      const result = await api.hf.open(body)
      setCurrent(result)
      void refresh()
    } catch (e) {
      setError({ code: e instanceof ApiError ? e.code : 'error', message: errorText(e) })
    } finally { setBusy(undefined) }
  }, [refresh])

  useEffect(() => { if (clipIds !== undefined && clipIds.length > 0) { setPending(clipIds); onClipsConsumed() } }, [clipIds, onClipsConsumed])
  useEffect(() => {
    if (pending === undefined) return
    for (const id of pending) if (cache[id] === undefined) void api.asset(id).then(r => { cacheAssets([r.asset]) }, () => undefined)
  }, [pending, cache])

  const importRenders = async (): Promise<void> => {
    if (current === undefined) return
    setBusy(t('hfImport'))
    try {
      const { assets } = await api.hf.importRenders(current.slug)
      cacheAssets(assets)
      wb.toast(assets.length > 0 ? t('hfImported', { n: assets.length }) : t('hfNoRenders'))
    } catch (e) { wb.toast(errorText(e), 'err') } finally { setBusy(undefined) }
  }
  const stop = async (): Promise<void> => {
    if (current === undefined) return
    try { await api.hf.stop(current.slug); setCurrent(undefined); void refresh() } catch (e) { wb.toast(errorText(e), 'err') }
  }

  if (current !== undefined) {
    const embeddable = isLoopbackPage()
    return (
      <div className="st-hf">
        <div className="st-row st-row--wrap">
          <Button size="sm" variant="ghost" onClick={() => { setCurrent(undefined) }}>← {t('hfBack')}</Button>
          <b className="st-grow">{current.slug}</b>
          <Button size="sm" onClick={() => { void importRenders() }} disabled={busy !== undefined}>{t('hfImport')}</Button>
          {embeddable && <a className="dk-button dk-button--outline dk-button--sm" style={{ textDecoration: 'none' }} href={current.url} target="_blank" rel="noopener noreferrer"><span className="dk-button__icon"><IconExternal size={14} /></span>{t('hfOpenExternal')}</a>}
          <Button size="sm" variant="ghost" icon={<IconStop size={12} />} onClick={() => { void stop() }}>{t('hfStop')}</Button>
        </div>
        {embeddable
          ? <iframe className="st-hf__frame" title={t('hfTitle')} src={current.url} allow="clipboard-read; clipboard-write; fullscreen" />
          : <div className="st-card st-col"><p style={{ margin: 0 }}>{t('hfRemote')}</p><div className="st-row"><code className="st-code st-grow">{current.url}</code><CopyButton text={current.url} /></div></div>}
      </div>
    )
  }

  const missing = error?.code === 'hyperframes-missing' || (status !== undefined && !status.available)
  const clips = pending?.map(id => cache[id]).filter((a): a is NonNullable<typeof a> => a !== undefined) ?? []
  return (
    <div className="st-body">
      <div className="st-col" style={{ gap: 4 }}>
        <h3 style={{ margin: 0, fontSize: 15 }}>{t('hfTitle')}</h3>
        <p className="st-muted" style={{ margin: 0 }}>{t('hfHint')}</p>
      </div>
      {missing && <div className="st-card st-col"><b>{t('hfMissing')}</b><span className="st-muted">{t('hfInstall')}</span><div><Button size="sm" icon={<IconRefresh size={12} />} onClick={() => { setError(undefined); void refresh() }}>{t('retryBtn')}</Button></div></div>}
      {error !== undefined && error.code !== 'hyperframes-missing' && <p className="st-error" role="alert"><b>{t('hfFailed')}:</b> {error.message}</p>}
      {busy !== undefined && <div className="st-row"><span className="st-bar st-bar--indeterminate st-grow"><span /></span><span className="st-muted st-small">{busy}</span></div>}
      {pending !== undefined && pending.length > 0 && (
        <div className="st-card st-col">
          <b>{t('hfFromSelection')} ({pending.length})</b>
          <div className="st-tray">{clips.map(a => <div key={a.id} className="st-slot"><img src={`/plugins/dsh-studio/v2/assets/${a.id}/thumb?w=128`} alt="" /></div>)}</div>
          <div className="st-row st-row--wrap">
            <div className="st-grow" style={{ minWidth: 140 }}><TextField label={t('hfSlug')} placeholder={t('hfSlug')} value={slug} onChange={(e) => { setSlug(e.target.value) }} /></div>
            <Button variant="primary" size="sm" icon={<IconLayers size={14} />} disabled={busy !== undefined || missing} onClick={() => { void open({ assetIds: pending, ...(slug.trim() === '' ? {} : { project: slug.trim() }) }).then(() => { setPending(undefined) }) }}>{t('hfNew')}</Button>
          </div>
        </div>
      )}
      <div className="st-col" style={{ gap: 6 }}>
        <h3 className="st-section-title">{t('hfProjects')}</h3>
        {status !== undefined && status.projects.length === 0 && <EmptyState title={t('hfProjects')} description={t('hfPickClips')} actions={<Button size="sm" disabled={busy !== undefined || missing} onClick={() => { void open({}) }}>{t('hfNewEmpty')}</Button>} />}
        {status?.projects.map(p => (
          <div key={p.slug} className="st-job st-row">
            <b className="st-grow">{p.slug}</b>
            <span className="st-badge" data-tone={p.running ? 'ok' : undefined}>{p.running ? t('hfRunning') : t('hfIdle')}</span>
            <Button size="sm" disabled={busy !== undefined || missing} onClick={() => { void open({ project: p.slug }) }}>{t('hfOpen')}</Button>
          </div>
        ))}
        {status !== undefined && status.projects.length > 0 && <div><Button size="sm" variant="ghost" disabled={busy !== undefined || missing} onClick={() => { void open({}) }}>{t('hfNewEmpty')}</Button></div>}
      </div>
    </div>
  )
}
