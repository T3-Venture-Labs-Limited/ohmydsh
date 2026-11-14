import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Button, SegmentedControl, Select } from '../../kit/index.js'
import type { ComposerPrefill } from '../studio-bus.js'
import { api } from './api.js'
import { OPS_BY_KIND, buildRequest, compatibleModels, missingInputs, slotMax, slotsFor, type TrayInputs, type UiOp } from './caps.js'
import { cacheAssets, assetCache } from './gallery-data.js'
import { useWorkbench } from './ctx.js'
import { usd } from './format.js'
import { t, type Key } from './i18n.js'
import { IconSparkle } from './icons.js'
import { JobsTray, registerCompareGroup } from './jobs.js'
import { carryOver, defaultsFor, ParamsForm, visibleValues, type ParamValues } from './params-form.js'
import { upsertJob, useModels } from './live.js'
import { TraySlotView } from './tray.js'
import { errorText } from './ui.js'
import type { AssetRecord, EstimateResult, MediaKind, ModelDescriptor } from './types.js'

const OP_LABEL: Record<UiOp, Key> = { generate: 'opGenerate', edit: 'opEdit', upscale: 'opUpscale', animate: 'opAnimate', restyle: 'opRestyle', extend: 'opExtend' }
const TIER_RANK = { value: 0, draft: 1, quality: 2 } as const
const priceLine = (m: ModelDescriptor): string => (m.pricing === undefined ? '' : ` · ~${usd(m.pricing.usd)}/${m.pricing.unit}`)

/** Remembers the last settings per kind so switching tabs/surfaces keeps the user's place. */
const memory: { kind: MediaKind; op: UiOp; modelId: Partial<Record<string, string>>; prompt: string; negative: string; params: Record<string, ParamValues> } = {
  kind: 'image', op: 'generate', modelId: {}, prompt: '', negative: '', params: {},
}

async function resolveAssets(ids: readonly (string | undefined)[]): Promise<AssetRecord[]> {
  const out: AssetRecord[] = []
  for (const id of ids) {
    if (id === undefined) continue
    const known = assetCache.get()[id]
    if (known !== undefined) { out.push(known); continue }
    try { const r = await api.asset(id); cacheAssets([r.asset]); out.push(r.asset) } catch { /* asset gone: skip */ }
  }
  return out
}

export function Composer({ prefill, onPrefillConsumed, compact = false }: { prefill: ComposerPrefill | undefined; onPrefillConsumed: () => void; compact?: boolean }) {
  const wb = useWorkbench()
  const { models, status, configured, error: modelsError } = useModels()
  const [kind, setKind] = useState<MediaKind>(memory.kind)
  const [op, setOp] = useState<UiOp>(memory.op)
  const [modelId, setModelId] = useState<string>(memory.modelId[`${memory.kind}:${memory.op}`] ?? '')
  const [prompt, setPrompt] = useState(memory.prompt)
  const [negative, setNegative] = useState(memory.negative)
  const [params, setParams] = useState<ParamValues>({})
  const [inputs, setInputs] = useState<TrayInputs>({})
  const [compare, setCompare] = useState<string[]>([])
  const [estimate, setEstimate] = useState<EstimateResult | undefined>()
  const [estimating, setEstimating] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [formError, setFormError] = useState<string | undefined>()
  const [advancedOpen, setAdvancedOpen] = useState(false)

  const candidates = useMemo(() => {
    const list = compatibleModels(models, kind, op, inputs)
    return [...list].sort((a, b) => Number(configured[b.provider] ?? false) - Number(configured[a.provider] ?? false) || Number(b.curated) - Number(a.curated)
      || (TIER_RANK[a.tier ?? 'value'] - TIER_RANK[b.tier ?? 'value']) || a.label.localeCompare(b.label))
  }, [models, kind, op, inputs, configured])
  const model = candidates.find(m => m.id === modelId)
  const usable = candidates.filter(m => configured[m.provider] ?? false)
  const specs = model?.params ?? []

  // Keep the chosen model valid as kind/op/inputs change; remember a choice per kind:op.
  useEffect(() => {
    if (status !== 'ready') return
    if (model !== undefined) return
    const remembered = memory.modelId[`${kind}:${op}`]
    const next = candidates.find(m => m.id === remembered && (configured[m.provider] ?? false)) ?? usable[0] ?? candidates[0]
    setModelId(next?.id ?? '')
  }, [status, model, candidates, usable, kind, op, configured])
  useEffect(() => { if (model !== undefined) memory.modelId[`${kind}:${op}`] = model.id }, [model, kind, op])
  useEffect(() => { setParams(prev => carryOver(prev === undefined ? {} : prev, specs)) }, [model?.id]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { memory.kind = kind; memory.op = op; memory.prompt = prompt; memory.negative = negative }, [kind, op, prompt, negative])
  useEffect(() => { setCompare(prev => prev.filter(id => id !== modelId && candidates.some(m => m.id === id))) }, [modelId, candidates])

  // Apply a prefill (from the lightbox, styles, jobs, tool cards).
  const prefillRef = useRef<ComposerPrefill | undefined>(undefined)
  useEffect(() => {
    if (prefill === undefined || prefill === prefillRef.current) return
    prefillRef.current = prefill
    void (async () => {
      const nextKind: MediaKind = prefill.kind ?? (prefill.op === 'animate' || prefill.op === 'extend' || prefill.op === 'restyle' && prefill.video !== undefined ? 'video' : 'image')
      const nextOp = (prefill.op ?? 'generate') as UiOp
      const [source, references, first, last, video] = await Promise.all([
        resolveAssets([prefill.source]), resolveAssets(prefill.references ?? []), resolveAssets([prefill.firstFrame]), resolveAssets([prefill.lastFrame]), resolveAssets([prefill.video]),
      ])
      setKind(nextKind); setOp(nextOp)
      setInputs({ source, references, firstFrame: first, lastFrame: last, video })
      if (prefill.prompt !== undefined) setPrompt(prefill.prompt)
      if (prefill.negativePrompt !== undefined) { setNegative(prefill.negativePrompt); setAdvancedOpen(true) }
      setModelId(prefill.modelId ?? '')
      if (prefill.params !== undefined) setParams(prefill.params)
      setCompare([])
      onPrefillConsumed()
    })()
  }, [prefill, onPrefillConsumed])

  // Live estimate (debounced, never spends).
  const requestBody = useMemo(() => (model === undefined ? undefined : buildRequest({ kind, op, modelId: model.id, prompt, negativePrompt: negative, params: visibleValues(params, specs), inputs })), [model, kind, op, prompt, negative, params, specs, inputs])
  useEffect(() => {
    if (requestBody === undefined) { setEstimate(undefined); return }
    setEstimating(true)
    const handle = setTimeout(() => {
      api.estimate(requestBody).then(r => { setEstimate(r); setEstimating(false) }, () => { setEstimate(undefined); setEstimating(false) })
    }, 350)
    return () => { clearTimeout(handle) }
  }, [requestBody])

  const missing = missingInputs(kind, op, inputs)
  const needsPrompt = !(op === 'upscale') && prompt.trim() === '' && !(op === 'generate' && false)
  const issues = estimate?.issues ?? []
  const keyMissing = model !== undefined && configured[model.provider] === false
  const canRun = model !== undefined && !keyMissing && missing.length === 0 && !needsPrompt && !submitting && (estimate === undefined || estimate.ok || estimate.issues.length === 0)

  const compareModels = compare.map(id => candidates.find(m => m.id === id)).filter((m): m is ModelDescriptor => m !== undefined)
  const submit = useCallback(async () => {
    if (model === undefined) return
    setSubmitting(true); setFormError(undefined)
    const group = compareModels.length > 0 ? `grp_${Date.now().toString(36)}` : undefined
    try {
      const targets = [model, ...compareModels]
      const results = await Promise.allSettled(targets.map(m => {
        const body = buildRequest({ kind, op, modelId: m.id, prompt, negativePrompt: negative, params: visibleValues(carryOver(params, m.params), m.params), inputs })
        return api.submit(body)
      }))
      const failures: string[] = []
      const ids: string[] = []
      results.forEach((r, i) => {
        if (r.status === 'fulfilled') { upsertJob(r.value.job); ids.push(r.value.job.id) } else failures.push(`${targets[i]!.label}: ${errorText(r.reason)}`)
      })
      if (group !== undefined && ids.length > 1) registerCompareGroup(group, ids)
      if (failures.length > 0) setFormError(`${t('submitFailed')}: ${failures.join(' · ')}`)
    } finally { setSubmitting(false) }
  }, [model, compareModels, kind, op, prompt, negative, params, inputs])

  const total = (estimate?.estimateUsd ?? 0) + compareModels.reduce((n, m) => n + (m.pricing?.unit === 'image' ? m.pricing.usd * Number(params.n ?? 1) : 0), 0)
  const slots = slotsFor(kind, op)
  const opOptions = OPS_BY_KIND[kind].map(value => ({ value, label: t(OP_LABEL[value]) }))

  const switchKind = (next: MediaKind): void => {
    setKind(next); setInputs({}); setCompare([])
    setOp(OPS_BY_KIND[next].includes(op) ? op : 'generate')
  }

  return (
    <div className="st-create" style={compact ? { display: 'flex', flexDirection: 'column', gap: 12 } : undefined}>
      <form className="st-col" style={{ gap: 12 }} onSubmit={(e) => { e.preventDefault(); if (canRun) void submit() }}>
        <div className="st-row st-row--wrap">
          <SegmentedControl<MediaKind> id="st-kind-switch" label={t('kind')} value={kind} onChange={switchKind} options={[{ value: 'image', label: t('kindImage') }, { value: 'video', label: t('kindVideo') }]} />
          <SegmentedControl<UiOp> id="st-op-switch" label={t('operation')} value={op} onChange={(v) => { setOp(v); setInputs(prev => ({ ...prev })) }} options={opOptions} />
        </div>

        {slots.map(slot => (
          <TraySlotView key={`${kind}-${op}-${slot.key}`} slot={slot} assets={inputs[slot.key] ?? []} max={slotMax(slot, model)}
            onChange={(next) => { setInputs(prev => ({ ...prev, [slot.key]: next })) }} onError={(m) => { setFormError(m) }} />
        ))}

        {op !== 'upscale' && (
          <div className="st-col" style={{ gap: 4 }}>
            <label className="dk-field__label" htmlFor="st-prompt">{t('prompt')}</label>
            <textarea id="st-prompt" className="st-textarea" rows={compact ? 3 : 4} value={prompt} placeholder={op === 'generate' ? t('promptPlaceholder') : t('promptPlaceholderEdit')}
              onChange={(e) => { setPrompt(e.target.value) }}
              onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && canRun) { e.preventDefault(); void submit() } }} />
          </div>
        )}

        <div className="st-model-pick">
          {status === 'loading' && <div className="st-skeleton" style={{ height: 34, borderRadius: 8 }} />}
          {modelsError !== undefined && <p className="st-error">{modelsError}</p>}
          {status === 'ready' && candidates.length === 0 && <p className="st-warn"><b>{t('noModel')}</b> {t('noModelHint')}</p>}
          {candidates.length > 0 && (
            <Select label={t('model')} value={model?.id ?? ''} onChange={setModelId}
              options={candidates.map(m => ({ value: m.id, label: `${m.label}${priceLine(m)}${configured[m.provider] === false ? ` (${t('providerOff')})` : ''}`, disabled: false }))} />
          )}
          {keyMissing && model !== undefined && <p className="st-warn">{t('needsKey', { provider: model.provider })}</p>}
        </div>

        {model !== undefined && <ParamsForm specs={specs} values={params} onChange={setParams} idPrefix="st-param" />}

        {op !== 'upscale' && (
          <div className="st-col" style={{ gap: 6 }}>
            <button type="button" className="st-link" style={{ alignSelf: 'flex-start' }} aria-expanded={advancedOpen} onClick={() => { setAdvancedOpen(v => !v) }}>{advancedOpen ? '▾' : '▸'} {t('advanced')}</button>
            {advancedOpen && (
              <div className="st-col" style={{ gap: 4 }}>
                <label className="dk-field__label" htmlFor="st-negative">{t('negativePrompt')}</label>
                <textarea id="st-negative" className="st-textarea" rows={2} style={{ minHeight: 56 }} value={negative} onChange={(e) => { setNegative(e.target.value) }} />
              </div>
            )}
          </div>
        )}

        {candidates.filter(m => m.id !== model?.id && (configured[m.provider] ?? false)).length > 0 && (
          <div className="st-col" style={{ gap: 4 }}>
            <span className="dk-field__label">{t('compareWith')} <span className="st-dim st-small">{t('compareHint')}</span></span>
            <div className="st-compare">
              {candidates.filter(m => m.id !== model?.id && (configured[m.provider] ?? false)).slice(0, 12).map(m => (
                <button key={m.id} type="button" className="st-chip" aria-pressed={compare.includes(m.id)} onClick={() => { setCompare(prev => (prev.includes(m.id) ? prev.filter(x => x !== m.id) : [...prev, m.id].slice(0, 3))) }}>{m.label}</button>
              ))}
            </div>
          </div>
        )}

        {formError !== undefined && <p className="st-error" role="alert">{formError}</p>}
        {issues.length > 0 && missing.length === 0 && !keyMissing && <p className="st-warn">{issues.map(i => i.message).join(' · ')}</p>}
        {missing.length > 0 && <p className="st-muted st-small">{t('needSource')}</p>}

        <div className="st-estimate">
          <span className="st-muted" aria-live="polite">
            {estimating ? t('estimating') : estimate?.estimateUsd !== undefined ? <>{t('estimate')}: <b style={{ color: 'var(--dsw-alias-label-primary)' }}>{usd(compareModels.length > 0 ? total : estimate.estimateUsd)}</b>{compareModels.length > 0 ? ` · ${t('compareN', { n: compareModels.length + 1 })}` : ''}</> : t('estimateUnknown')}
          </span>
          <Button type="submit" variant="primary" icon={<IconSparkle size={14} />} disabled={!canRun}>{submitting ? t('waiting') : op === 'generate' ? t('generateBtn') : t('runBtn')}</Button>
        </div>
      </form>
      <div className="st-col" style={{ gap: 8, minWidth: 0 }}>
        <JobsTray compact={compact} onOpenRequest={(p) => { wb.compose(p) }} />
      </div>
    </div>
  )
}
