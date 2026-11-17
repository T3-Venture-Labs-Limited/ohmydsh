import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Button, EmptyState, Modal, Select, SegmentedControl, TextField } from '../../kit/index.js'
import { api } from './api.js'
import { assetCache, toggleFavorite, useGalleryData } from './gallery-data.js'
import { useWorkbench } from './ctx.js'
import { bytes, usd } from './format.js'
import { t } from './i18n.js'
import { IconCheck, IconDownload, IconFolder, IconPlus, IconSelect, IconTrash } from './icons.js'
import { KindBadge, MediaThumb, StarToggle, errorText } from './ui.js'
import { liveStore, sortedJobs } from './live.js'
import { LegacyImport } from './legacy-import.js'
import { AgentMediaImport } from './agent-import.js'
import { useStore } from './store.js'
import { isActive, type AssetQuery, type AssetRecord, type SpendRow } from './types.js'
import { useModels } from './live.js'

type KindFilter = 'all' | 'image' | 'video'

export function AssetTile({ asset, selected, selecting, onOpen, onSelect, onFav }: {
  asset: AssetRecord; selected: boolean; selecting: boolean; onOpen: () => void; onSelect: () => void; onFav: () => void
}) {
  return (
    <div className="st-rel">
      <button type="button" className="st-tile" data-selected={selected} onClick={selecting ? onSelect : onOpen} aria-label={`${t('openItem')}: ${asset.title ?? asset.prompt ?? asset.id}`}>
        <MediaThumb asset={asset} hoverPlay w={360} />
        <KindBadge asset={asset} />
        <span className="st-tile__hud"><span>{asset.width !== undefined ? `${String(asset.width)}×${String(asset.height ?? '')}` : ''}</span><span>{asset.costUsd !== undefined ? usd(asset.costUsd) : ''}</span></span>
      </button>
      {!selecting && <StarToggle on={asset.favorite} onToggle={onFav} className="st-tile__fav" />}
      <button type="button" role="checkbox" aria-checked={selected} aria-label={t('selectItem')} className="st-tile__check" onClick={onSelect} style={{ top: asset.kind === 'video' ? 28 : 4 }}>
        {selected && <IconCheck size={14} />}
      </button>
    </div>
  )
}

function RunningTiles() {
  const jobs = useStore(liveStore, s => s.jobs)
  const running = sortedJobs(jobs).filter(j => isActive(j.state))
  if (running.length === 0) return null
  return <>{running.map(job => (
    <div key={job.id} className="st-tile st-skeleton" style={{ cursor: 'default' }} role="status" aria-label={t('stateRunning')}>
      <span className="st-tile__job">
        <span>{job.state === 'running' ? t('stateRunning') : t('stateQueued')}</span>
        <span className={`st-bar ${job.progress === undefined ? 'st-bar--indeterminate' : ''}`} style={{ width: '70%' }}><span style={{ width: `${String(Math.round((job.progress ?? 0) * 100))}%` }} /></span>
      </span>
    </div>
  ))}</>
}

export function GalleryView({ compact = false }: { compact?: boolean }) {
  const wb = useWorkbench()
  const [kind, setKind] = useState<KindFilter>('all')
  const [favorite, setFavorite] = useState(false)
  const [fromChats, setFromChats] = useState(false)
  const [q, setQ] = useState('')
  const [qApplied, setQApplied] = useState('')
  const [tag, setTag] = useState('')
  const [model, setModel] = useState('')
  const [collection, setCollection] = useState('')
  const [tags, setTags] = useState<{ tag: string; count: number }[]>([])
  const [collections, setCollections] = useState<{ id: string; name: string; count: number }[]>([])
  const [selecting, setSelecting] = useState(false)
  const [selected, setSelected] = useState<string[]>([])
  const [spendOpen, setSpendOpen] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [busy, setBusy] = useState<string | undefined>()
  const [newCollection, setNewCollection] = useState<{ ids: string[]; name: string } | undefined>()
  const [stats, setStats] = useState<{ count: number; bytes: number } | undefined>()
  const models = useModels()

  useEffect(() => { const id = setTimeout(() => { setQApplied(q) }, 250); return () => { clearTimeout(id) } }, [q])
  const refreshMeta = useCallback(() => {
    void api.tags().then(r => { setTags(r.tags) }, () => undefined)
    void api.collections().then(r => { setCollections(r.collections) }, () => undefined)
    void api.stats().then(setStats, () => undefined)
  }, [])
  useEffect(refreshMeta, [refreshMeta])

  const query = useMemo<AssetQuery>(() => ({
    ...(kind === 'all' ? {} : { kind }), ...(favorite ? { favorite: true } : {}), ...(fromChats ? { fromChats: true } : {}), ...(qApplied.trim() === '' ? {} : { q: qApplied.trim() }),
    ...(tag === '' ? {} : { tag }), ...(model === '' ? {} : { model }), ...(collection === '' ? {} : { collection }),
  }), [kind, favorite, fromChats, qApplied, tag, model, collection])
  const data = useGalleryData(query)
  const ids = useMemo(() => data.items.map(i => i.id), [data.items])
  const sentinel = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const node = sentinel.current
    if (node === null || !data.hasMore) return
    const observer = new IntersectionObserver((entries) => { if (entries.some(e => e.isIntersecting)) data.more() }, { rootMargin: '400px' })
    observer.observe(node)
    return () => { observer.disconnect() }
  }, [data.hasMore, data.more, data.items.length])

  const toggleSelect = (id: string): void => { setSelected(prev => (prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id])) }
  const exitSelect = (): void => { setSelecting(false); setSelected([]) }

  const importFiles = async (files: FileList | File[]): Promise<void> => {
    const list = [...files].filter(f => f.type.startsWith('image/') || f.type.startsWith('video/'))
    if (list.length === 0) return
    setBusy(t('importing'))
    try { for (const file of list) await api.importFile(file, { title: file.name.replace(/\.[^.]+$/, '') }); wb.toast(`${String(list.length)} imported`) }
    catch (error) { wb.toast(errorText(error), 'err') } finally { setBusy(undefined); refreshMeta() }
  }

  const zip = async (): Promise<void> => {
    if (selected.length === 0) return
    setBusy(t('downloadZip'))
    try {
      const blob = await api.zipBlob(selected)
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a'); a.href = url; a.download = `studio-${String(selected.length)}-assets.zip`; document.body.appendChild(a); a.click(); a.remove()
      setTimeout(() => { URL.revokeObjectURL(url) }, 10_000)
    } catch (error) { wb.toast(errorText(error), 'err') } finally { setBusy(undefined) }
  }
  const removeSelected = async (): Promise<void> => {
    if (selected.length === 0 || !window.confirm(t('confirmDelete', { n: selected.length }))) return
    try { await Promise.all(selected.map(id => api.deleteAsset(id))); data.remove(selected); exitSelect(); refreshMeta() } catch (error) { wb.toast(errorText(error), 'err') }
  }
  const addToCollection = async (collectionId: string): Promise<void> => {
    try { await Promise.all(selected.map(id => api.toggleCollection(id, { add: collectionId }))); wb.toast('Added'); refreshMeta() } catch (error) { wb.toast(errorText(error), 'err') }
  }
  const createCollection = async (): Promise<void> => {
    if (newCollection === undefined || newCollection.name.trim() === '') return
    try {
      const made = await api.createCollection(newCollection.name.trim())
      await Promise.all(newCollection.ids.map(id => api.toggleCollection(id, { add: made.id })))
      setNewCollection(undefined); wb.toast('Collection created'); refreshMeta()
    } catch (error) { wb.toast(errorText(error), 'err') }
  }
  const tagSelected = async (): Promise<void> => {
    const value = window.prompt(t('addTag'))?.trim().toLowerCase()
    if (value === undefined || value === '') return
    try { await Promise.all(selected.map(id => api.tag(id, { add: [value] }))); wb.toast('Tagged'); refreshMeta() } catch (error) { wb.toast(errorText(error), 'err') }
  }

  const modelOptions = [{ value: '', label: t('anyModel') }, ...models.models.filter(m => data.items.some(i => i.modelId === m.id) || m.id === model).map(m => ({ value: m.id, label: m.label }))]
  const filtersActive = kind !== 'all' || favorite || fromChats || q !== '' || tag !== '' || model !== '' || collection !== ''

  return (
    <div
      className={`st-rel ${selecting ? 'st-sel-mode' : ''}`}
      style={{ display: 'flex', flexDirection: 'column', gap: 10, flex: 1, minHeight: 0 }}
      onDragOver={(e) => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); setDragging(true) } }}
      onDragLeave={(e) => { if (e.currentTarget === e.target) setDragging(false) }}
      onDrop={(e) => { if (e.dataTransfer.files.length > 0) { e.preventDefault(); setDragging(false); void importFiles(e.dataTransfer.files) } }}
    >
      <div className="st-drop" data-on={dragging}>{t('dropToImport')}</div>
      <div className="st-filters">
        <div className="st-filters__row">
          <div className="st-grow" style={{ minWidth: 140 }}>
            <TextField label={t('searchPrompts')} hideLabel placeholder={t('searchPrompts')} value={q} onChange={(e) => { setQ(e.target.value) }} type="search" />
          </div>
          <Button size="sm" variant="outline" icon={<IconSelect size={14} />} aria-pressed={selecting} onClick={() => { if (selecting) exitSelect(); else setSelecting(true) }}>{t('select')}</Button>
          <Button size="sm" variant="ghost" onClick={() => { setSpendOpen(true) }}>{t('spend')}</Button>
        </div>
        <div className="st-filters__row">
          <SegmentedControl<KindFilter> id="st-kind" label="Media kind" value={kind} onChange={setKind} options={[{ value: 'all', label: t('all') }, { value: 'image', label: t('images') }, { value: 'video', label: t('videos') }]} />
          <button type="button" className="st-chip" aria-pressed={favorite} onClick={() => { setFavorite(v => !v) }}>★ {t('favorites')}</button>
          <button type="button" className="st-chip" aria-pressed={fromChats} onClick={() => { setFromChats(v => !v) }}>{t('fromChats')}</button>
          {filtersActive && <button type="button" className="st-chip" onClick={() => { setKind('all'); setFavorite(false); setFromChats(false); setQ(''); setTag(''); setModel(''); setCollection('') }}>{t('clear')}</button>}
        </div>
        {!compact && (
          <div className="st-filters__row">
            <Select label={t('anyTag')} hideLabel value={tag} onChange={setTag} options={[{ value: '', label: t('anyTag') }, ...tags.map(x => ({ value: x.tag, label: `${x.tag} (${String(x.count)})` }))]} />
            <Select label={t('anyModel')} hideLabel value={model} onChange={setModel} options={modelOptions} />
            <Select label={t('anyCollection')} hideLabel value={collection} onChange={setCollection} options={[{ value: '', label: t('anyCollection') }, ...collections.map(c => ({ value: c.id, label: `${c.name} (${String(c.count)})` }))]} />
          </div>
        )}
      </div>

      {data.error !== undefined && <p className="st-error" role="alert">{data.error} <button type="button" className="st-link" onClick={() => { void data.reload() }}>{t('retryBtn')}</button></p>}
      {data.items.length === 0 && !data.loading && data.error === undefined && Object.keys(liveStore.get().jobs).length === 0 && (
        <EmptyState title={t('emptyGallery')} description={t('emptyGalleryHint')} actions={<Button variant="primary" size="sm" onClick={() => { wb.go('create') }}>{t('tabCreate')}</Button>} />
      )}
      <div className="st-grid" style={{ ['--st-tile' as string]: compact ? '110px' : '160px' }}>
        {!filtersActive && <RunningTiles />}
        {data.loading && data.items.length === 0 && Array.from({ length: 8 }, (_, i) => <div key={i} className="st-tile st-skeleton" style={{ cursor: 'default' }} />)}
        {data.items.map(asset => (
          <AssetTile key={asset.id} asset={asset} selecting={selecting} selected={selected.includes(asset.id)}
            onOpen={() => { wb.openAsset(asset.id, ids) }} onSelect={() => { if (!selecting) setSelecting(true); toggleSelect(asset.id) }} onFav={() => { void toggleFavorite(asset, data.update) }} />
        ))}
      </div>
      <div ref={sentinel} style={{ height: 1 }} />
      <div className="st-row st-small st-dim" style={{ justifyContent: 'space-between' }}>
        <span>{data.total > 0 ? t('nOfTotal', { n: data.items.length, total: data.total }) : ''}{stats !== undefined && !filtersActive ? ` · ${bytes(stats.bytes)} stored` : ''}</span>
        <span className="st-row">
          {data.hasMore && <Button size="sm" onClick={data.more} disabled={data.loading}>{t('loadMore')}</Button>}
          <AgentMediaImport onDone={() => { void data.reload(); refreshMeta() }} />
          <LegacyImport onDone={() => { void data.reload(); refreshMeta() }} />
          <label className="st-link"><input type="file" accept="image/*,video/*" multiple className="st-sr-only" onChange={(e) => { if (e.target.files !== null) void importFiles(e.target.files); e.target.value = '' }} />{busy ?? t('importFiles')}</label>
        </span>
      </div>

      {selecting && (
        <div className="st-selbar" role="toolbar" aria-label={t('actions')}>
          <b>{t('selectedN', { n: selected.length })}</b>
          <span className="st-grow" />
          <Button size="sm" icon={<IconDownload size={14} />} disabled={selected.length === 0 || busy !== undefined} onClick={() => { void zip() }}>{t('downloadZip')}</Button>
          <Button size="sm" onClick={() => { void tagSelected() }} disabled={selected.length === 0}>{t('addTag')}</Button>
          <Select label={t('addToCollection')} hideLabel value="" disabled={selected.length === 0} onChange={(v) => { if (v === '__new') setNewCollection({ ids: selected, name: '' }); else if (v !== '') void addToCollection(v) }}
            options={[{ value: '', label: t('addToCollection') }, ...collections.map(c => ({ value: c.id, label: c.name })), { value: '__new', label: t('newCollection') }]} />
          <Button size="sm" variant="danger" icon={<IconTrash size={14} />} disabled={selected.length === 0} onClick={() => { void removeSelected() }}>{t('deleteSelected')}</Button>
          <Button size="sm" onClick={exitSelect}>{t('clear')}</Button>
        </div>
      )}

      <Modal open={newCollection !== undefined} onClose={() => { setNewCollection(undefined) }} title={t('newCollection')} closeLabel={t('close')}
        footer={<><Button onClick={() => { setNewCollection(undefined) }}>{t('cancel')}</Button><Button variant="primary" onClick={() => { void createCollection() }}>{t('create')}</Button></>}>
        <TextField label={t('collectionName')} data-modal-autofocus value={newCollection?.name ?? ''} onChange={(e) => { setNewCollection(prev => (prev === undefined ? prev : { ...prev, name: e.target.value })) }}
          onKeyDown={(e) => { if (e.key === 'Enter') void createCollection() }} />
      </Modal>
      <SpendDialog open={spendOpen} onClose={() => { setSpendOpen(false) }} />
    </div>
  )
}

type Range = '7' | '30' | 'all'
export function SpendDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [range, setRange] = useState<Range>('30')
  const [rows, setRows] = useState<SpendRow[] | undefined>()
  const [error, setError] = useState<string | undefined>()
  useEffect(() => {
    if (!open) return
    setRows(undefined)
    const since = range === 'all' ? 0 : Date.now() - Number(range) * 86_400_000
    api.spend(since).then(r => { setRows(r.spend); setError(undefined) }, (e: unknown) => { setError(errorText(e)) })
  }, [open, range])
  const total = rows?.reduce((n, r) => n + r.usd, 0) ?? 0
  const count = rows?.reduce((n, r) => n + r.count, 0) ?? 0
  const perDay = useMemo(() => {
    const map = new Map<string, number>()
    for (const r of rows ?? []) map.set(r.day, (map.get(r.day) ?? 0) + r.usd)
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  }, [rows])
  const perProvider = useMemo(() => {
    const map = new Map<string, { usd: number; count: number }>()
    for (const r of rows ?? []) { const cur = map.get(r.provider) ?? { usd: 0, count: 0 }; map.set(r.provider, { usd: cur.usd + r.usd, count: cur.count + r.count }) }
    return [...map.entries()].sort((a, b) => b[1].usd - a[1].usd)
  }, [rows])
  const max = Math.max(0.0001, ...perDay.map(d => d[1]))
  return (
    <Modal open={open} onClose={onClose} title={t('spendTitle')} closeLabel={t('close')} description={t('spendHint')}>
      <div className="st-col" style={{ gap: 14, minWidth: 0 }}>
        <SegmentedControl<Range> id="st-spend-range" label="Range" value={range} onChange={setRange} options={[{ value: '7', label: t('last7') }, { value: '30', label: t('last30') }, { value: 'all', label: t('allTime') }]} />
        {error !== undefined && <p className="st-error">{error}</p>}
        {rows === undefined && error === undefined && <div className="st-skeleton" style={{ height: 80, borderRadius: 8 }} />}
        {rows !== undefined && rows.length === 0 && <p className="st-muted">{t('noSpend')}</p>}
        {rows !== undefined && rows.length > 0 && (<>
          <div className="st-row" style={{ gap: 24 }}>
            <div className="st-stat"><span className="st-dim st-small">{t('total')}</span><b>{usd(total)}</b></div>
            <div className="st-stat"><span className="st-dim st-small">{t('assetsN', { n: count })}</span><b>{count}</b></div>
          </div>
          <div><h3 className="st-section-title">{t('perDay')}</h3>
            <div className="st-spend-bars" role="img" aria-label={t('perDay')}>{perDay.map(([day, value]) => <div key={day} title={`${day}: ${usd(value)}`} style={{ height: `${String(Math.max(4, (value / max) * 100))}%` }} />)}</div>
            <div className="st-row st-small st-dim" style={{ justifyContent: 'space-between' }}><span>{perDay[0]?.[0]}</span><span>{perDay[perDay.length - 1]?.[0]}</span></div>
          </div>
          <div><h3 className="st-section-title">{t('perProvider')}</h3>
            {perProvider.map(([provider, v]) => <div key={provider} className="st-row" style={{ justifyContent: 'space-between', padding: '4px 0' }}><span>{provider}</span><span className="st-muted">{t('assetsN', { n: v.count })} · <b style={{ color: 'var(--dsw-alias-label-primary)' }}>{usd(v.usd)}</b></span></div>)}
          </div>
        </>)}
      </div>
    </Modal>
  )
}
void assetCache; void IconFolder; void IconPlus
