import { useCallback, useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { Button, IconButton, SegmentedControl } from '../../kit/index.js'
import { useModalLayer } from '../../kit/modal-layer.js'
import { useKitStyles } from '../../kit/styles.js'
import { api, fileUrl, thumbUrl } from './api.js'
import { assetCache, cacheAssets, patchCached, toggleFavorite } from './gallery-data.js'
import { useWorkbench } from './ctx.js'
import { bytes, duration, usd, when } from './format.js'
import { t } from './i18n.js'
import { IconChevronLeft, IconChevronRight, IconDownload, IconFilm, IconImage, IconLayers, IconSparkle, IconStar, IconUpscale } from './icons.js'
import { labelOf } from './live.js'
import { useStore } from './store.js'
import { CopyButton, StarToggle, errorText } from './ui.js'
import type { AssetEdge, AssetRecord } from './types.js'
import { IconClose } from '../../kit/icons.js'
import { useRef } from 'react'
import { MaskEditor } from './mask-editor.js'
import { Modal } from '../../kit/index.js'

interface Detail { asset: AssetRecord; parents: AssetEdge[]; children: AssetEdge[]; collections: string[]; nodes: AssetRecord[]; edges: AssetEdge[] }

export function Lightbox({ assetId, siblings, onClose, onNavigate }: { assetId: string; siblings: readonly string[]; onClose: () => void; onNavigate: (id: string) => void }) {
  useKitStyles()
  const wb = useWorkbench()
  const dialog = useRef<HTMLDivElement>(null)
  useModalLayer(dialog, true, onClose)
  const cached = useStore(assetCache, s => s[assetId])
  const [detail, setDetail] = useState<Detail | undefined>()
  const [error, setError] = useState<string | undefined>()
  const [collections, setCollections] = useState<{ id: string; name: string }[]>([])
  const [tagText, setTagText] = useState('')
  const [pane, setPane] = useState<'details' | 'lineage'>('details')
  const [masking, setMasking] = useState(false)
  const asset = cached ?? detail?.asset

  const load = useCallback(async () => {
    try {
      const [one, graph] = await Promise.all([api.asset(assetId), api.lineage(assetId)])
      cacheAssets([one.asset, ...graph.nodes])
      setDetail({ asset: one.asset, parents: one.parents, children: one.children, collections: one.collections ?? [], nodes: graph.nodes, edges: graph.edges })
      setError(undefined)
    } catch (e) { setError(errorText(e)) }
  }, [assetId])
  useEffect(() => { setDetail(undefined); void load() }, [load])
  useEffect(() => { void api.collections().then(r => { setCollections(r.collections) }, () => undefined) }, [])

  const index = siblings.indexOf(assetId)
  const go = useCallback((step: number) => { const next = siblings[index + step]; if (next !== undefined) onNavigate(next) }, [siblings, index, onNavigate])
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement) return
      if (e.key === 'ArrowLeft') go(-1); else if (e.key === 'ArrowRight') go(1)
    }
    window.addEventListener('keydown', onKey)
    return () => { window.removeEventListener('keydown', onKey) }
  }, [go])

  if (asset === undefined) {
    return createPortal(
      <div className="dk-modal-root"><div className="dk-modal-mask" onClick={onClose} aria-hidden="true" />
        <div ref={dialog} tabIndex={-1} className="dk-modal st-lb-modal" role="dialog" aria-modal="true" aria-label="Asset" style={{ padding: 24 }}>
          {error !== undefined ? <p className="st-error">{error}</p> : <div className="st-skeleton" style={{ width: 320, height: 240, borderRadius: 8 }} />}
        </div></div>, document.body)
  }

  const setTags = async (change: { add?: string[]; remove?: string[] }): Promise<void> => {
    try { const r = await api.tag(asset.id, change); patchCached(asset.id, { tags: r.tags }) } catch (e) { wb.toast(errorText(e), 'err') }
  }
  const toggleCollection = async (id: string, on: boolean): Promise<void> => {
    try {
      await api.toggleCollection(asset.id, on ? { remove: id } : { add: id })
      setDetail(d => (d === undefined ? d : { ...d, collections: on ? d.collections.filter(c => c !== id) : [...d.collections, id] }))
    } catch (e) { wb.toast(errorText(e), 'err') }
  }
  const setRating = async (value: number): Promise<void> => {
    const next = asset.rating === value ? null : value
    patchCached(asset.id, next === null ? { rating: 0 } : { rating: next })
    try { await api.patchAsset(asset.id, { rating: next }) } catch (e) { wb.toast(errorText(e), 'err') }
  }
  const remove = async (): Promise<void> => {
    if (!window.confirm(t('confirmDelete', { n: 1 }))) return
    try { await api.deleteAsset(asset.id); onClose(); wb.toast('Deleted') } catch (e) { wb.toast(errorText(e), 'err') }
  }
  const compose = (prefill: Parameters<typeof wb.compose>[0]): void => { onClose(); wb.compose(prefill) }
  const video = asset.kind === 'video'
  const params = asset.params === undefined ? [] : Object.entries(asset.params)

  return createPortal(
    <div className="dk-modal-root" role="presentation">
      <div className="dk-modal-mask" aria-hidden="true" onClick={onClose} />
      <div ref={dialog} tabIndex={-1} className="dk-modal st-lb-modal" role="dialog" aria-modal="true" aria-label={asset.title ?? asset.prompt ?? asset.id} style={{ padding: 16 }}>
        <div className="st-lb">
          <div className="st-lb__stage">
            {video
              ? <video key={asset.id} src={fileUrl(asset.id)} controls autoPlay loop playsInline poster={`${thumbUrl(asset.id)}`} />
              : <img key={asset.id} src={fileUrl(asset.id)} alt={asset.title ?? asset.prompt ?? asset.id} />}
            {index > 0 && <button type="button" className="st-lb__nav st-lb__nav--prev" aria-label={t('previous')} onClick={() => { go(-1) }}><IconChevronLeft /></button>}
            {index >= 0 && index < siblings.length - 1 && <button type="button" className="st-lb__nav st-lb__nav--next" aria-label={t('next')} onClick={() => { go(1) }}><IconChevronRight /></button>}
          </div>
          <div className="st-lb__side">
            <div className="st-row">
              <SegmentedControl<'details' | 'lineage'> id="st-lb-pane" label="Panel" value={pane} onChange={setPane} options={[{ value: 'details', label: t('details') }, { value: 'lineage', label: t('lineage') }]} />
              <span className="st-grow" />
              <StarToggle on={asset.favorite} className="dk-icon-button" onToggle={() => { void toggleFavorite(asset, (id, p) => { patchCached(id, p) }) }} />
              <IconButton label={t('close')} icon={<IconClose size={14} />} onClick={onClose} />
            </div>
            {pane === 'details' ? (<>
              {asset.prompt !== undefined && (<div className="st-col" style={{ gap: 4 }}>
                <div className="st-row"><h3 className="st-section-title st-grow">{t('prompt')}</h3><CopyButton text={asset.prompt} /></div>
                <p className="st-lb__prompt">{asset.prompt}</p>
                {asset.negativePrompt !== undefined && <><h3 className="st-section-title">{t('negativePrompt')}</h3><p className="st-lb__prompt">{asset.negativePrompt}</p></>}
              </div>)}
              <dl className="st-kv">
                <dt>{t('model')}</dt><dd>{asset.modelId === undefined ? t('unknownModel') : labelOf(asset.modelId)}</dd>
                <dt>{t('source')}</dt><dd>{asset.source}{asset.op !== undefined ? ` · ${asset.op}` : ''}</dd>
                <dt>{t('size')}</dt><dd>{asset.width !== undefined ? `${String(asset.width)}×${String(asset.height ?? '')} · ` : ''}{video ? `${duration(asset.durationMs)} · ` : ''}{bytes(asset.bytes)}</dd>
                <dt>{t('created')}</dt><dd>{when(asset.createdAt)}</dd>
                {asset.costUsd !== undefined && <><dt>{t('cost')}</dt><dd>{usd(asset.costUsd)}</dd></>}
                {asset.seed !== undefined && <><dt>{t('seed')}</dt><dd>{asset.seed}</dd></>}
                {params.length > 0 && <><dt>{t('params')}</dt><dd>{params.map(([k, v]) => `${k}: ${String(v)}`).join(' · ')}</dd></>}
              </dl>
              <div className="st-row" role="group" aria-label={t('rating')}>
                <span className="st-stars">{[1, 2, 3, 4, 5].map(n => <button key={n} type="button" data-on={(asset.rating ?? 0) >= n} aria-label={`${String(n)} / 5`} onClick={() => { void setRating(n) }}><IconStar size={16} filled={(asset.rating ?? 0) >= n} /></button>)}</span>
              </div>
              <div className="st-col" style={{ gap: 6 }}>
                <h3 className="st-section-title">{t('tags')}</h3>
                <div className="st-row st-row--wrap">
                  {asset.tags.map(tag => <span key={tag} className="st-tag">{tag}<button type="button" aria-label={`Remove ${tag}`} onClick={() => { void setTags({ remove: [tag] }) }}>×</button></span>)}
                  <input className="dk-input__control st-tag" style={{ width: 110, height: 22 }} placeholder={t('addTagPlaceholder')} aria-label={t('addTag')} value={tagText} onChange={(e) => { setTagText(e.target.value) }}
                    onKeyDown={(e) => { if (e.key === 'Enter' && tagText.trim() !== '') { void setTags({ add: [tagText.trim()] }); setTagText('') } }} />
                </div>
              </div>
              {collections.length > 0 && (<div className="st-col" style={{ gap: 6 }}>
                <h3 className="st-section-title">{t('collections')}</h3>
                <div className="st-row st-row--wrap">{collections.map(c => { const on = detail?.collections.includes(c.id) ?? false; return <button key={c.id} type="button" className="st-chip" aria-pressed={on} onClick={() => { void toggleCollection(c.id, on) }}>{c.name}</button> })}</div>
              </div>)}
            </>) : <Lineage detail={detail} current={asset.id} onOpen={onNavigate} />}

            <div className="st-col" style={{ gap: 6 }}>
              <h3 className="st-section-title">{t('actions')}</h3>
              <div className="st-row st-row--wrap">
                {!video && <Button size="sm" icon={<IconUpscale size={14} />} onClick={() => { compose({ kind: 'image', op: 'upscale', source: asset.id }) }}>{t('upscale')}</Button>}
                {!video && <Button size="sm" icon={<IconFilm size={14} />} onClick={() => { compose({ kind: 'video', op: 'animate', firstFrame: asset.id, ...(asset.prompt === undefined ? {} : { prompt: asset.prompt }) }) }}>{t('animate')}</Button>}
                {!video && <Button size="sm" icon={<IconSparkle size={14} />} onClick={() => { compose({ kind: 'image', op: 'edit', source: asset.id }) }}>{t('restyle')}</Button>}
                {!video && asset.width !== undefined && <Button size="sm" icon={<IconSparkle size={14} />} onClick={() => { setMasking(true) }}>{t('inpaint')}</Button>}
                {!video && asset.width !== undefined && <Button size="sm" icon={<IconSparkle size={14} />} onClick={() => { setMasking(true) }}>{t('inpaint')}</Button>}
                {video && <Button size="sm" icon={<IconSparkle size={14} />} onClick={() => { compose({ kind: 'video', op: 'restyle', video: asset.id, ...(asset.prompt === undefined ? {} : { prompt: asset.prompt }) }) }}>{t('restyle')}</Button>}
                {video && <Button size="sm" icon={<IconUpscale size={14} />} onClick={() => { compose({ kind: 'video', op: 'upscale', video: asset.id }) }}>{t('upscale')}</Button>}
                {video && <Button size="sm" onClick={() => { compose({ kind: 'video', op: 'extend', video: asset.id, ...(asset.prompt === undefined ? {} : { prompt: asset.prompt }) }) }}>{t('extend')}</Button>}
                {!video && <Button size="sm" icon={<IconImage size={14} />} onClick={() => { compose({ kind: 'image', op: 'generate', references: [asset.id], ...(asset.prompt === undefined ? {} : { prompt: asset.prompt }) }) }}>{t('useAsReference')}</Button>}
                {asset.prompt !== undefined && <Button size="sm" onClick={() => { compose({ kind: asset.kind, op: 'generate', prompt: asset.prompt!, ...(asset.negativePrompt === undefined ? {} : { negativePrompt: asset.negativePrompt }), ...(asset.modelId === undefined ? {} : { modelId: asset.modelId }), ...(asset.params === undefined ? {} : { params: asset.params as Record<string, string | number | boolean> }) }) }}>{t('openInComposer')}</Button>}
                <Button size="sm" icon={<IconLayers size={14} />} onClick={() => { onClose(); wb.hyperframes([asset.id]) }}>{t('openInHyperFrames')}</Button>
                <a className="dk-button dk-button--ghost dk-button--sm" href={fileUrl(asset.id)} download={`${asset.id}.${asset.ext}`} style={{ textDecoration: 'none' }}><span className="dk-button__icon"><IconDownload size={14} /></span>{t('download')}</a>
                <Button size="sm" variant="danger" onClick={() => { void remove() }}>{t('delete')}</Button>
              </div>
            </div>
          </div>
        </div>
      </div>
      {masking && !video && <Modal open onClose={() => { setMasking(false) }} title={`${t('inpaint')} · ${t('expandCanvas')}`} closeLabel={t('close')} className="st-lb-modal"><MaskEditor asset={asset} onClose={() => { setMasking(false); onClose() }} /></Modal>}
    </div>, document.body)
}

function Lineage({ detail, current, onOpen }: { detail: Detail | undefined; current: string; onOpen: (id: string) => void }) {
  const nodes = useMemo(() => new Map((detail?.nodes ?? []).map(n => [n.id, n])), [detail])
  if (detail === undefined) return <div className="st-skeleton" style={{ height: 80, borderRadius: 8 }} />
  if (detail.edges.length === 0) return <p className="st-muted">{t('lineageEmpty')}</p>
  // Depth of each node relative to the current one: ancestors negative, descendants positive.
  const depth = new Map<string, number>([[current, 0]])
  const walkUp = (id: string, d: number): void => { for (const e of detail.edges.filter(x => x.childId === id)) if (!depth.has(e.parentId)) { depth.set(e.parentId, d - 1); walkUp(e.parentId, d - 1) } }
  const walkDown = (id: string, d: number): void => { for (const e of detail.edges.filter(x => x.parentId === id)) if (!depth.has(e.childId)) { depth.set(e.childId, d + 1); walkDown(e.childId, d + 1) } }
  walkUp(current, 0); walkDown(current, 0)
  const levels = new Map<number, string[]>()
  for (const [id, d] of depth) levels.set(d, [...(levels.get(d) ?? []), id])
  const ordered = [...levels.entries()].sort((a, b) => a[0] - b[0])
  const roleOf = (child: string): string => detail.edges.find(e => e.childId === child)?.role ?? ''
  return (
    <div className="st-col" style={{ gap: 12 }}>
      {ordered.map(([level, ids]) => (
        <div key={level} className="st-col" style={{ gap: 4 }}>
          <h3 className="st-section-title">{level < 0 ? t('parents') : level > 0 ? t('children') : t('thisAsset')}</h3>
          <div className="st-lineage">
            {ids.map(id => { const n = nodes.get(id); return (
              <button key={id} type="button" className="st-lineage__item" aria-current={id === current} onClick={() => { onOpen(id) }} title={n?.prompt ?? id}>
                <span>{n !== undefined ? <img src={thumbUrl(id, 128)} alt="" loading="lazy" /> : null}</span>
                <span>{level > 0 ? roleOf(id).replace(/_/g, ' ') : n?.kind ?? ''}</span>
              </button>) })}
          </div>
        </div>
      ))}
    </div>
  )
}
