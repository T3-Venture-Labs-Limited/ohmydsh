// MaskEditor + expand-canvas: paint what to change (brush / eraser / rectangle / lasso, undo/redo, grow, invert), export a
// source-size PNG (white = change; polarity is the host's business) and run the inpaint job. Outpaint = /assets/expand
// then the same inpaint job.
import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { Button, SegmentedControl, Select, TextField } from '../../kit/index.js'
import { api, fileUrl } from './api.js'
import { applyOp, clampPoint, exportMaskPng, fractionOf, maskWarning, replay, type MaskOp } from './mask-canvas.js'
import { cacheAssets } from './gallery-data.js'
import { useWorkbench } from './ctx.js'
import { usd } from './format.js'
import { t } from './i18n.js'
import { IconRefresh } from './icons.js'
import { upsertJob, useModels } from './live.js'
import { errorText } from './ui.js'
import type { AssetRecord, ModelDescriptor } from './types.js'

type Tool = 'brush' | 'eraser' | 'rect' | 'lasso'
type Mode = 'mask' | 'expand'

const TOOLS: { value: Tool; key: 'toolBrush' | 'toolEraser' | 'toolRect' | 'toolLasso' }[] = [
  { value: 'brush', key: 'toolBrush' }, { value: 'eraser', key: 'toolEraser' }, { value: 'rect', key: 'toolRect' }, { value: 'lasso', key: 'toolLasso' },
]

export function inpaintModels(models: readonly ModelDescriptor[], configured: Readonly<Record<string, boolean>>): ModelDescriptor[] {
  return models.filter(m => m.capabilities.includes('inpaint') && !(m.deprecated ?? false))
    .sort((a, b) => Number(configured[b.provider] ?? false) - Number(configured[a.provider] ?? false) || (a.pricing?.usd ?? 9) - (b.pricing?.usd ?? 9))
}
export function modeHint(model: ModelDescriptor | undefined): string | undefined {
  if (model === undefined) return undefined
  return model.inpaintMode === 'markup' ? t('modeMarkup') : model.inpaintMode === 'overlay-prompt' ? t('modeOverlay') : t('modeMask')
}

export function MaskEditor({ asset, onClose }: { asset: AssetRecord; onClose: () => void }) {
  const wb = useWorkbench()
  const { models, configured } = useModels()
  const [mode, setMode] = useState<Mode>('mask')
  const [tool, setTool] = useState<Tool>('brush')
  const [size, setSize] = useState(48)
  const [growPx, setGrowPx] = useState(8)
  const [showKeep, setShowKeep] = useState(false)
  const [prompt, setPrompt] = useState('')
  const [modelId, setModelId] = useState('')
  const [busy, setBusy] = useState<string | undefined>()
  const [error, setError] = useState<string | undefined>()
  const [fraction, setFraction] = useState(0)
  const [version, setVersion] = useState(0)
  const [pad, setPad] = useState({ top: 0, right: 0, bottom: 0, left: 0 })
  const [overlap, setOverlap] = useState(16)

  const W = asset.width ?? 1024, H = asset.height ?? 1024
  const edit = useRef<HTMLCanvasElement | null>(null)
  const view = useRef<HTMLCanvasElement | null>(null)
  const ops = useRef<MaskOp[]>([])
  const redo = useRef<MaskOp[]>([])
  const draft = useRef<MaskOp | undefined>(undefined)
  const image = useRef<HTMLImageElement | null>(null)
  const [loaded, setLoaded] = useState(false)

  const candidates = useMemo(() => inpaintModels(models, configured), [models, configured])
  const model = candidates.find(m => m.id === modelId)
  useEffect(() => { if (model === undefined && candidates.length > 0) setModelId((candidates.find(m => configured[m.provider]) ?? candidates[0]!).id) }, [model, candidates, configured])

  useEffect(() => {
    const c = document.createElement('canvas'); c.width = W; c.height = H
    edit.current = c
    const img = new Image(); img.onload = () => { image.current = img; setLoaded(true) }; img.src = fileUrl(asset.id)
    return () => { edit.current = null }
  }, [asset.id, W, H])

  const paint = useCallback(() => {
    const canvas = view.current, mask = edit.current, img = image.current
    if (canvas === null || mask === null) return
    const ctx = canvas.getContext('2d')!
    ctx.clearRect(0, 0, W, H)
    if (img !== null) ctx.drawImage(img, 0, 0, W, H)
    const layer = document.createElement('canvas'); layer.width = W; layer.height = H
    const lctx = layer.getContext('2d')!
    lctx.drawImage(mask, 0, 0)
    if (draft.current !== undefined) applyOp(lctx, draft.current)
    if (showKeep) {
      // Preview of the area that is kept: dim everything that is NOT painted.
      const dim = document.createElement('canvas'); dim.width = W; dim.height = H
      const d = dim.getContext('2d')!
      d.fillStyle = '#000'; d.fillRect(0, 0, W, H) // artwork:ok
      d.globalCompositeOperation = 'destination-out'; d.drawImage(layer, 0, 0)
      ctx.globalAlpha = 0.65; ctx.drawImage(dim, 0, 0); ctx.globalAlpha = 1
    } else { ctx.globalAlpha = 0.55; ctx.drawImage(layer, 0, 0); ctx.globalAlpha = 1 }
  }, [W, H, showKeep])
  useEffect(() => { if (loaded) paint() }, [loaded, paint, version])

  const commit = (op: MaskOp): void => {
    const mask = edit.current; if (mask === null) return
    ops.current.push(op); redo.current = []
    applyOp(mask.getContext('2d')!, op)
    setFraction(fractionOf(mask)); setVersion(v => v + 1)
  }
  const undo = (): void => {
    const mask = edit.current; const last = ops.current.pop(); if (mask === null || last === undefined) return
    redo.current.push(last); replay(mask.getContext('2d')!, ops.current); setFraction(fractionOf(mask)); setVersion(v => v + 1)
  }
  const redoOp = (): void => {
    const mask = edit.current; const next = redo.current.pop(); if (mask === null || next === undefined) return
    ops.current.push(next); applyOp(mask.getContext('2d')!, next); setFraction(fractionOf(mask)); setVersion(v => v + 1)
  }
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement) return
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); if (e.shiftKey) redoOp(); else undo() }
      else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') { e.preventDefault(); redoOp() }
    }
    window.addEventListener('keydown', onKey)
    return () => { window.removeEventListener('keydown', onKey) }
  })

  const point = (e: ReactPointerEvent<HTMLCanvasElement>): [number, number] => {
    const rect = e.currentTarget.getBoundingClientRect()
    return clampPoint(((e.clientX - rect.left) / rect.width) * W, ((e.clientY - rect.top) / rect.height) * H, W, H)
  }
  const start = useRef<[number, number] | undefined>(undefined)
  const onDown = (e: ReactPointerEvent<HTMLCanvasElement>): void => {
    if (mode !== 'mask') return
    e.currentTarget.setPointerCapture(e.pointerId)
    const p = point(e); start.current = p
    const erase = tool === 'eraser'
    if (tool === 'brush' || tool === 'eraser') draft.current = { type: 'stroke', erase, size, pts: [p] }
    else if (tool === 'lasso') draft.current = { type: 'lasso', erase: e.altKey, pts: [p] }
    else draft.current = { type: 'rect', erase: e.altKey, x: p[0], y: p[1], w: 0, h: 0 }
    paint()
  }
  const onMove = (e: ReactPointerEvent<HTMLCanvasElement>): void => {
    const op = draft.current; if (op === undefined || start.current === undefined) return
    const p = point(e)
    if (op.type === 'stroke' || op.type === 'lasso') draft.current = { ...op, pts: [...op.pts, p] }
    else if (op.type === 'rect') draft.current = { ...op, x: Math.min(start.current[0], p[0]), y: Math.min(start.current[1], p[1]), w: Math.abs(p[0] - start.current[0]), h: Math.abs(p[1] - start.current[1]) }
    paint()
  }
  const onUp = (): void => {
    const op = draft.current; draft.current = undefined; start.current = undefined
    if (op === undefined) return
    if (op.type === 'rect' && (op.w < 2 || op.h < 2)) { paint(); return }
    commit(op)
  }

  const warn = maskWarning(fraction)
  const total = { w: W + pad.left + pad.right, h: H + pad.top + pad.bottom }
  const expandSides = pad.top + pad.right + pad.bottom + pad.left
  const expandInvalid = expandSides === 0 ? t('expandNone') : total.w > 8192 || total.h > 8192 ? t('expandTooBig') : undefined
  const estimate = model?.pricing?.unit === 'image' ? model.pricing.usd : undefined

  const submitJob = async (source: string, mask: string, status: string): Promise<void> => {
    if (model === undefined) throw new Error(t('noInpaintModel'))
    setBusy(status)
    const job = await api.submit({ op: 'inpaint', modelId: model.id, prompt: prompt.trim(), inputs: { source: { assetId: source }, mask: { assetId: mask } }, params: {} })
    upsertJob(job.job); wb.toast(t('jobStarted')); onClose()
  }
  const runInpaint = async (): Promise<void> => {
    const mask = edit.current; if (mask === null) return
    setError(undefined); setBusy(t('uploadingMask'))
    try {
      const { blob } = await exportMaskPng(mask, growPx)
      const saved = await api.createMask(blob, asset.id)
      const w = maskWarning(saved.stats.editedFraction)
      if (w !== undefined) { setError(w === 'empty' ? t('maskEmpty') : t('maskFull')); setBusy(undefined); return }
      cacheAssets([saved.asset])
      await submitJob(asset.id, saved.asset.id, t('submittingJob'))
    } catch (e) { setError(errorText(e)) } finally { setBusy(undefined) }
  }
  const runExpand = async (): Promise<void> => {
    setError(undefined); setBusy(t('uploadingMask'))
    try {
      const made = await api.expand({ assetId: asset.id, ...pad, overlap })
      cacheAssets([made.image, made.mask])
      await submitJob(made.image.id, made.mask.id, t('submittingJob'))
    } catch (e) { setError(errorText(e)) } finally { setBusy(undefined) }
  }

    const fit = Math.min(1, 640 / Math.max(total.w, 1), 420 / Math.max(total.h, 1))
  return (
    <div className="st-col st-mask" style={{ gap: 12, width: '100%' }}>
      <SegmentedControl<Mode> id="st-mask-mode" label={t('inpaint')} value={mode} onChange={setMode} options={[{ value: 'mask', label: t('paintMask') }, { value: 'expand', label: t('expandCanvas') }]} />
      {mode === 'mask' ? (<>
        <p className="st-muted st-small" style={{ margin: 0 }}>{t('maskHint')}</p>
        <div className="st-row st-row--wrap" role="toolbar" aria-label={t('paintMask')}>
          {TOOLS.map(x => <button key={x.value} type="button" className="st-chip" aria-pressed={tool === x.value} onClick={() => { setTool(x.value) }}>{t(x.key)}</button>)}
          <span className="st-grow" />
          <Button size="sm" onClick={undo} disabled={ops.current.length === 0}>{t('undo')}</Button>
          <Button size="sm" onClick={redoOp} disabled={redo.current.length === 0}>{t('redo')}</Button>
          <Button size="sm" onClick={() => { commit({ type: 'invert' }) }}>{t('invertMask')}</Button>
          <Button size="sm" onClick={() => { commit({ type: 'fill' }) }}>{t('fillMask')}</Button>
          <Button size="sm" variant="ghost" onClick={() => { commit({ type: 'clear' }) }}>{t('clearMask')}</Button>
        </div>
        <div className="st-row st-row--wrap">
          {(tool === 'brush' || tool === 'eraser') && <label className="st-row st-small" style={{ flex: '1 1 180px' }}>{t('brushSize')}: <b>{size}</b><input className="st-range" type="range" min={4} max={Math.max(64, Math.round(Math.max(W, H) / 4))} value={size} onChange={(e) => { setSize(Number(e.target.value)) }} aria-label={t('brushSize')} /></label>}
          <label className="st-row st-small" style={{ flex: '1 1 180px' }} title={t('growHint')}>{t('growEdges')}: <b>{growPx}px</b><input className="st-range" type="range" min={0} max={48} value={growPx} onChange={(e) => { setGrowPx(Number(e.target.value)) }} aria-label={t('growEdges')} /></label>
          <button type="button" className="st-chip" aria-pressed={showKeep} onClick={() => { setShowKeep(v => !v) }}>{t('showKeep')}</button>
        </div>
        <div className="st-rel" style={{ alignSelf: 'center', maxWidth: '100%', lineHeight: 0, borderRadius: 'var(--dsw-radius-md)', overflow: 'hidden', background: 'var(--dsw-alias-bg-skeleton)' }}>
          <canvas ref={view} width={W} height={H} aria-label={t('paintMask')} role="img" className="st-mask-canvas"
            style={{ maxWidth: '100%', width: 'auto', height: 'auto', display: 'block', touchAction: 'none', cursor: 'crosshair' }}
            onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp} />
        </div>
        <div className="st-row st-small" aria-live="polite">
          <span className="st-muted">{warn === 'empty' ? t('maskEmpty') : warn === 'full' ? t('maskFull') : t('maskCoverage', { pct: fraction < 0.01 ? '<1' : Math.round(fraction * 100) })}</span>
        </div>
      </>) : (<>
        <p className="st-muted st-small" style={{ margin: 0 }}>{t('expandHint', { n: overlap })}</p>
        <div className="st-row st-row--wrap">
          <span className="st-small st-dim">{t('expandPreset')}:</span>
          {[128, 256, 512].map(n => <button key={n} type="button" className="st-chip" onClick={() => { setPad({ top: n, right: n, bottom: n, left: n }) }}>{t('expandAll')} +{n}</button>)}
          <button type="button" className="st-chip" onClick={() => { setPad({ top: 0, right: Math.round(W / 2), bottom: 0, left: Math.round(W / 2) }) }}>2:1 wide</button>
          <button type="button" className="st-chip" onClick={() => { setPad({ top: 0, right: 0, bottom: 0, left: 0 }) }}>{t('clearMask')}</button>
        </div>
        <div className="st-params">
          {(['top', 'right', 'bottom', 'left'] as const).map(side => (
            <TextField key={side} label={t(side === 'top' ? 'expandTop' : side === 'right' ? 'expandRight' : side === 'bottom' ? 'expandBottom' : 'expandLeft')} type="number" inputMode="numeric" min={0} max={4096} value={String(pad[side])}
              onChange={(e) => { const n = Math.max(0, Math.min(4096, Math.floor(Number(e.target.value) || 0))); setPad(prev => ({ ...prev, [side]: n })) }} />
          ))}
          <TextField label={t('expandOverlap')} type="number" inputMode="numeric" min={0} max={128} value={String(overlap)} onChange={(e) => { setOverlap(Math.max(0, Math.min(128, Math.floor(Number(e.target.value) || 0)))) }} />
        </div>
        <div className="st-rel" style={{ alignSelf: 'center', width: Math.max(80, total.w * fit), height: Math.max(60, total.h * fit), background: 'var(--dsw-alias-bg-skeleton)', border: '1px dashed var(--dsw-alias-border-selected)', borderRadius: 'var(--dsw-radius-sm)' }} aria-label={t('expandResult', { w: total.w, h: total.h })} role="img">
          <img src={fileUrl(asset.id)} alt="" style={{ position: 'absolute', left: pad.left * fit, top: pad.top * fit, width: W * fit, height: H * fit, display: 'block' }} />
        </div>
        <span className="st-small st-muted" aria-live="polite">{expandInvalid ?? t('expandResult', { w: total.w, h: total.h })}</span>
      </>)}

      <div className="st-col" style={{ gap: 4 }}>
        <label className="dk-field__label" htmlFor="st-inpaint-prompt">{t('inpaintPrompt')}</label>
        <textarea id="st-inpaint-prompt" className="st-textarea" rows={2} style={{ minHeight: 56 }} value={prompt} onChange={(e) => { setPrompt(e.target.value) }} />
      </div>
      {candidates.length === 0
        ? <p className="st-warn">{t('noInpaintModel')}</p>
        : <>
          <Select label={t('model')} value={model?.id ?? ''} onChange={setModelId} options={candidates.map(m => ({ value: m.id, label: `${m.label}${m.pricing === undefined ? '' : ` · ~${usd(m.pricing.usd)}/${m.pricing.unit}`}${configured[m.provider] === false ? ` (${t('providerOff')})` : ''}` }))} />
          {modeHint(model) !== undefined && <p className="st-muted st-small" style={{ margin: 0 }}>{modeHint(model)}</p>}
          {model !== undefined && configured[model.provider] === false && <p className="st-warn">{t('needsKey', { provider: model.provider })}</p>}
        </>}
      {error !== undefined && <p className="st-error" role="alert">{error}</p>}
      <div className="st-estimate st-mask-actions">
        <span className="st-muted">{estimate !== undefined ? <>{t('estimate')}: <b style={{ color: 'var(--dsw-alias-label-primary)' }}>{usd(estimate)}</b></> : t('estimateUnknown')}</span>
        <span className="st-row">
          <Button onClick={onClose} disabled={busy !== undefined}>{t('cancel')}</Button>
          {mode === 'mask'
            ? <Button variant="primary" icon={<IconRefresh size={14} />} disabled={busy !== undefined || model === undefined || (configured[model.provider] === false) || warn !== undefined || prompt.trim() === ''} onClick={() => { void runInpaint() }}>{busy ?? t('runInpaint')}</Button>
            : <Button variant="primary" icon={<IconRefresh size={14} />} disabled={busy !== undefined || model === undefined || (configured[model.provider] === false) || expandInvalid !== undefined || prompt.trim() === ''} onClick={() => { void runExpand() }}>{busy ?? t('runExpand')}</Button>}
        </span>
      </div>
    </div>
  )
}
