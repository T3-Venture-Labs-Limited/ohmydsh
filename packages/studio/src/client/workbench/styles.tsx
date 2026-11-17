import { useEffect, useMemo, useState } from 'react'
import { Button, EmptyState, SegmentedControl, Select, TextField } from '../../kit/index.js'
import { api, thumbUrl } from './api.js'
import { useWorkbench } from './ctx.js'
import { toggleFavorite, useGalleryData } from './gallery-data.js'
import { clip } from './format.js'
import { t } from './i18n.js'
import { IconExternal } from './icons.js'
import { useModels } from './live.js'
import { STYLES, STYLE_CATEGORIES, type StylePrompt } from './styles-data.js'
import { CopyButton, MediaThumb, StarToggle } from './ui.js'
import type { ModelExample } from './types.js'

type Pane = 'library' | 'favorites' | 'examples'

const fill = (style: StylePrompt, subject: string): string => style.prompt.replace('{subject}', subject.trim() === '' ? t('styleSubject') : subject.trim())

function Library() {
  const wb = useWorkbench()
  const [q, setQ] = useState('')
  const [category, setCategory] = useState<string>('all')
  const [subject, setSubject] = useState('')
  const [open, setOpen] = useState<string | undefined>()
  const list = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return STYLES.filter(s => (category === 'all' || s.category === category) && (needle === '' || `${s.name} ${s.prompt} ${s.tags.join(' ')}`.toLowerCase().includes(needle)))
  }, [q, category])
  return (
    <div className="st-col" style={{ gap: 10 }}>
      <p className="st-muted st-small" style={{ margin: 0 }}>{t('styleHint')}</p>
      <div className="st-row st-row--wrap">
        <div className="st-grow" style={{ minWidth: 150 }}><TextField label={t('searchStyles')} hideLabel placeholder={t('searchStyles')} type="search" value={q} onChange={(e) => { setQ(e.target.value) }} /></div>
        <div className="st-grow" style={{ minWidth: 150 }}><TextField label={t('styleSubject')} hideLabel placeholder={t('subjectPlaceholder')} value={subject} onChange={(e) => { setSubject(e.target.value) }} /></div>
      </div>
      <div className="st-row st-row--wrap">
        <button type="button" className="st-chip" aria-pressed={category === 'all'} onClick={() => { setCategory('all') }}>{t('allCategories')}</button>
        {STYLE_CATEGORIES.map(c => <button key={c} type="button" className="st-chip" aria-pressed={category === c} onClick={() => { setCategory(c) }}>{c}</button>)}
      </div>
      <div className="st-styles-grid">
        {list.map(style => {
          const text = fill(style, subject)
          return (
            <article key={style.id} className="st-style" data-open={open === style.id}>
              <div className="st-row"><b className="st-grow">{style.name}</b><span className="st-badge">{style.category}</span></div>
              <p className="st-style__text">{text}</p>
              <button type="button" className="st-link st-small" style={{ alignSelf: 'flex-start' }} onClick={() => { setOpen(prev => (prev === style.id ? undefined : style.id)) }}>{open === style.id ? 'Less' : 'More'}</button>
              <div className="st-row">
                <Button size="sm" variant="primary" onClick={() => { wb.compose({ kind: 'image', op: 'generate', prompt: text, ...(style.negative === undefined ? {} : { negativePrompt: style.negative }), ...(style.aspect === undefined ? {} : { params: { aspect_ratio: style.aspect } }) }) }}>{t('useStyle')}</Button>
                <CopyButton text={text} label={t('copyPrompt')} id={style.id} />
                <span className="st-grow" />
                {style.aspect !== undefined && <span className="st-dim st-small">{style.aspect}</span>}
              </div>
            </article>
          )
        })}
      </div>
      {list.length === 0 && <EmptyState title={t('emptyGallery')} />}
    </div>
  )
}

function Favorites() {
  const wb = useWorkbench()
  const data = useGalleryData({ favorite: true })
  const ids = data.items.map(i => i.id)
  if (data.items.length === 0 && !data.loading) return <EmptyState title={t('noFavorites')} description={t('noFavoritesHint')} />
  return (
    <div className="st-styles-grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))' }}>
      {data.items.map(asset => (
        <article key={asset.id} className="st-style" style={{ padding: 6 }}>
          <div className="st-rel">
            <button type="button" className="st-tile" style={{ aspectRatio: '4/3' }} onClick={() => { wb.openAsset(asset.id, ids) }} aria-label={asset.title ?? asset.prompt ?? asset.id}><MediaThumb asset={asset} hoverPlay /></button>
            <StarToggle on={asset.favorite} onToggle={() => { void toggleFavorite(asset, data.update) }} />
          </div>
          {asset.prompt !== undefined && <p className="st-style__text" style={{ WebkitLineClamp: 2 }}>{asset.prompt}</p>}
          <div className="st-row st-row--wrap">
            {asset.prompt !== undefined && <Button size="sm" onClick={() => { wb.compose({ kind: asset.kind, op: 'generate', prompt: asset.prompt!, ...(asset.modelId === undefined ? {} : { modelId: asset.modelId }) }) }}>{t('reusePrompt')}</Button>}
            {asset.kind === 'image' && <Button size="sm" onClick={() => { wb.compose({ kind: 'image', op: 'generate', references: [asset.id] }) }}>{t('useAsReference')}</Button>}
            {asset.kind === 'image' && <Button size="sm" onClick={() => { wb.compose({ kind: 'video', op: 'animate', firstFrame: asset.id, ...(asset.prompt === undefined ? {} : { prompt: asset.prompt }) }) }}>{t('makeVideo')}</Button>}
          </div>
        </article>
      ))}
      {data.hasMore && <Button size="sm" onClick={data.more}>{t('loadMore')}</Button>}
    </div>
  )
}

function Examples() {
  const wb = useWorkbench()
  const { models, configured } = useModels()
  const options = useMemo(() => models.filter(m => m.provider === 'replicate' || m.provider === 'openrouter'), [models])
  const [modelId, setModelId] = useState('')
  const [state, setState] = useState<{ available: boolean; examples: ModelExample[] } | undefined>()
  const [error, setError] = useState<string | undefined>()
  useEffect(() => { if (modelId === '' && options.length > 0) setModelId((options.find(m => m.provider === 'replicate') ?? options[0]!).id) }, [options, modelId])
  const model = options.find(m => m.id === modelId)
  useEffect(() => {
    if (model === undefined || model.provider !== 'replicate') { setState(undefined); return }
    let live = true
    setState(undefined); setError(undefined)
    api.examples(model.id).then(r => { if (live) setState(r) }, (e: unknown) => { if (live) setError(e instanceof Error ? e.message : String(e)) })
    return () => { live = false }
  }, [model])
  const replicateKey = configured.replicate === true
  return (
    <div className="st-col" style={{ gap: 12 }}>
      <Select label={t('examplesPick')} value={modelId} onChange={setModelId} options={options.map(m => ({ value: m.id, label: `${m.label} · ${m.provider}` }))} />
      {model !== undefined && model.provider === 'openrouter' && <p className="st-muted">{t('examplesNotReplicate')}</p>}
      {model !== undefined && model.provider === 'replicate' && !replicateKey && <div className="st-card"><b>{t('examplesNeedToken')}</b><p className="st-muted" style={{ margin: '4px 0 0' }}>{t('examplesNeedTokenHint')}</p></div>}
      {error !== undefined && <p className="st-error">{error}</p>}
      {state !== undefined && !state.available && replicateKey && <p className="st-muted">{t('examplesNone')}</p>}
      {state !== undefined && state.available && state.examples.length === 0 && <p className="st-muted">{t('examplesNone')}</p>}
      {state !== undefined && state.examples.length > 0 && (
        <div className="st-styles-grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(190px, 1fr))' }}>
          {state.examples.map((ex, i) => (
            <article key={ex.pageUrl + String(i)} className="st-ex">
              {ex.thumbUrl !== undefined ? <img src={ex.thumbUrl} alt={ex.title ?? ''} loading="lazy" referrerPolicy="no-referrer" /> : <div className="st-skeleton" style={{ aspectRatio: '4/3' }} />}
              <div>
                <b>{clip(ex.title ?? model?.label ?? '', 60)}</b>
                {ex.summary !== undefined && <span className="st-muted st-small">{clip(ex.summary, 120)}</span>}
                <div className="st-row st-row--wrap">
                  {typeof ex.input?.prompt === 'string' && <Button size="sm" onClick={() => { wb.compose({ kind: 'image', op: 'generate', prompt: String(ex.input!.prompt), ...(model === undefined ? {} : { modelId: model.id }) }) }}>{t('remix')}</Button>}
                  <a className="st-link st-small" href={ex.pageUrl} target="_blank" rel="noopener noreferrer">{t('viewOnReplicate')} <IconExternal size={11} /></a>
                </div>
              </div>
            </article>
          ))}
        </div>
      )}
      {model !== undefined && (
        <div className="st-row st-row--wrap st-small st-dim">
          <span>{t('exampleSource')}</span>
          {model.provider === 'openrouter' && <a className="st-link" href={`https://openrouter.ai/${model.remoteId}`} target="_blank" rel="noopener noreferrer">{t('viewOnOpenRouter')} <IconExternal size={11} /></a>}
        </div>
      )}
    </div>
  )
}

export function StylesView() {
  const [pane, setPane] = useState<Pane>('library')
  return (
    <div className="st-col" style={{ gap: 12 }}>
      <SegmentedControl<Pane> id="st-styles-pane" label="Styles section" value={pane} onChange={setPane} options={[{ value: 'library', label: t('stylesLibrary') }, { value: 'favorites', label: t('stylesFavorites') }, { value: 'examples', label: t('stylesExamples') }]} />
      {pane === 'library' ? <Library /> : pane === 'favorites' ? <Favorites /> : <Examples />}
    </div>
  )
}
void thumbUrl
