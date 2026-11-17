import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { SegmentedControl } from '../../kit/index.js'
import { useKitStyles } from '../../kit/styles.js'
import { studioBus, type ComposerPrefill, type StudioIntent, type StudioTab } from '../studio-bus.js'
import { Composer } from './composer.js'
import { WorkbenchContext, type WorkbenchApi } from './ctx.js'
import { GalleryView, AssetTile } from './gallery.js'
import { toggleFavorite, useGalleryData } from './gallery-data.js'
import { HyperFramesPane } from './hyperframes.js'
import { t } from './i18n.js'
import { Lightbox } from './lightbox.js'
import { retainLive } from './live.js'
import { StylesView } from './styles.js'
import { Toasts } from './ui.js'
import { Button } from '../../kit/index.js'
import cssText from './studio.css?inline'

/** The workbench stylesheet, injected while any workbench surface is mounted (ref-counted). */
let mounted = 0
let tag: HTMLStyleElement | undefined
function useStudioStyles(): void {
  useKitStyles()
  useEffect(() => {
    if (mounted++ === 0) { tag = document.createElement('style'); tag.dataset.plugin = 'dsh-studio-workbench'; tag.textContent = cssText; document.head.appendChild(tag) }
    return () => { if (--mounted === 0) { tag?.remove(); tag = undefined } }
  }, [])
}
export { useStudioStyles }

function Recent({ onOpen }: { onOpen: (id: string, siblings: string[]) => void }) {
  const wb = { go: undefined }
  void wb
  const data = useGalleryData({})
  const items = data.items.slice(0, 8)
  const ids = items.map(i => i.id)
  if (items.length === 0) return null
  return (
    <section className="st-col" style={{ gap: 6 }}>
      <h3 className="st-section-title">{t('recent')}</h3>
      <div className="st-grid" style={{ ['--st-tile' as string]: '72px' }}>
        {items.map(a => <AssetTile key={a.id} asset={a} selected={false} selecting={false} onOpen={() => { onOpen(a.id, ids) }} onSelect={() => undefined} onFav={() => { void toggleFavorite(a, data.update) }} />)}
      </div>
    </section>
  )
}

export interface WorkbenchProps {
  /** Docked in the right sidebar (compact) vs full-width view. */
  inSidebar?: boolean
  initialTab?: StudioTab
  /** Called when the user wants more room (full view). */
  onExpand?: (() => void) | undefined
}

export function StudioWorkbench({ inSidebar = false, initialTab = 'create' }: WorkbenchProps) {
  useStudioStyles()
  const [tab, setTab] = useState<StudioTab>(initialTab)
  const [prefill, setPrefill] = useState<ComposerPrefill | undefined>()
  const [hfClips, setHfClips] = useState<string[] | undefined>()
  const [light, setLight] = useState<{ id: string; siblings: readonly string[] } | undefined>()
  const [toasts, setToasts] = useState<{ id: number; message: string; tone: 'ok' | 'err' }[]>([])
  const nextToast = useRef(1)
  const root = useRef<HTMLDivElement>(null)
  const [wide, setWide] = useState(!inSidebar)

  useEffect(() => retainLive(), [])
  useEffect(() => {
    const el = root.current
    if (el === null || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver((entries) => { const w = entries[0]?.contentRect.width ?? 0; setWide(w >= 760) })
    observer.observe(el)
    return () => { observer.disconnect() }
  }, [])

  const toast = useCallback((message: string, tone: 'ok' | 'err' = 'ok') => {
    const id = nextToast.current++
    setToasts(prev => [...prev, { id, message, tone }])
    setTimeout(() => { setToasts(prev => prev.filter(x => x.id !== id)) }, tone === 'err' ? 6000 : 2800)
  }, [])

  const handle = useCallback((intent: StudioIntent) => {
    setTab(intent.tab)
    if (intent.tab === 'create' && intent.prefill !== undefined) setPrefill({ ...intent.prefill })
    if (intent.tab === 'gallery' && intent.assetId !== undefined) setLight({ id: intent.assetId, siblings: [intent.assetId] })
    if (intent.tab === 'video' && intent.assetIds !== undefined) setHfClips([...intent.assetIds])
  }, [])
  useEffect(() => studioBus.subscribe(handle), [handle])

  const api = useMemo<WorkbenchApi>(() => ({
    go: setTab,
    openAsset: (id, siblings) => { setLight({ id, siblings: siblings ?? [id] }) },
    compose: (p) => { setPrefill({ ...p }); setTab('create') },
    hyperframes: (ids) => { setHfClips([...ids]); setTab('video') },
    toast, wide,
  }), [toast, wide])

  const tabs = [
    { value: 'create' as const, label: t('tabCreate') }, { value: 'gallery' as const, label: t('tabGallery') },
    { value: 'styles' as const, label: t('tabStyles') }, { value: 'video' as const, label: t('tabVideo') },
  ]
  const consumed = useCallback(() => { setPrefill(undefined) }, [])
  const clipsConsumed = useCallback(() => { setHfClips(undefined) }, [])
  const compact = inSidebar && !wide

  return (
    <WorkbenchContext.Provider value={api}>
      <div ref={root} className="st-root st-rel">
        <div className="st-head">
          <div className="st-head__tabs"><SegmentedControl<StudioTab> id="st-tabs" label={t('studio')} value={tab} onChange={setTab} options={tabs} /></div>
        </div>
        {/* All panes stay mounted-on-demand; Create keeps its state through the module-level memory in composer.tsx. */}
        {tab === 'create' && (
          <div className="st-body">
            <Composer prefill={prefill} onPrefillConsumed={consumed} compact={compact} />
            {compact && <Recent onOpen={(id, siblings) => { setLight({ id, siblings }) }} />}
            {compact && <div><Button size="sm" variant="ghost" onClick={() => { setTab('gallery') }}>{t('openGallery')} →</Button></div>}
          </div>
        )}
        {tab === 'gallery' && <div className="st-body"><GalleryView compact={compact} /></div>}
        {tab === 'styles' && <div className="st-body"><StylesView /></div>}
        {tab === 'video' && <HyperFramesPane clipIds={hfClips} onClipsConsumed={clipsConsumed} />}
        {light !== undefined && <Lightbox assetId={light.id} siblings={light.siblings} onClose={() => { setLight(undefined) }} onNavigate={(id) => { setLight(prev => ({ id, siblings: prev?.siblings ?? [id] })) }} />}
        <Toasts items={toasts} />
      </div>
    </WorkbenchContext.Provider>
  )
}
