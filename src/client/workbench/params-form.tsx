// Capability-driven ParamSpec form: controls come only from the model descriptor, never from provider names.
import { Select, Switch, TextField } from '../../kit/index.js'
import type { ParamSpec, ParamValue } from './types.js'

export type ParamValues = Record<string, ParamValue>

export function defaultsFor(specs: readonly ParamSpec[]): ParamValues {
  const out: ParamValues = {}
  for (const spec of specs) if ('default' in spec && spec.default !== undefined) out[spec.key] = spec.default
  return out
}

/** A param is visible when its `when` gate matches the effective (chosen or default) value of the gating param. */
export function isVisible(spec: ParamSpec, values: ParamValues, specs: readonly ParamSpec[]): boolean {
  if (spec.when === undefined) return true
  const gate = values[spec.when.key] ?? (specs.find(s => s.key === spec.when!.key) as { default?: ParamValue } | undefined)?.default
  return gate !== undefined && spec.when.in.includes(gate)
}

/** Keep only params that exist on the model and are visible; used when switching models. */
export function carryOver(previous: ParamValues, specs: readonly ParamSpec[]): ParamValues {
  const next = defaultsFor(specs)
  for (const spec of specs) {
    const value = previous[spec.key]
    if (value === undefined) continue
    if (spec.type === 'enum' && typeof value === 'string' && spec.values.includes(value)) next[spec.key] = value
    else if ((spec.type === 'number' || spec.type === 'integer') && typeof value === 'number' && value >= spec.min && value <= spec.max) next[spec.key] = value
    else if (spec.type === 'boolean' && typeof value === 'boolean') next[spec.key] = value
    else if (spec.type === 'text' && typeof value === 'string') next[spec.key] = value
  }
  return next
}

export function visibleValues(values: ParamValues, specs: readonly ParamSpec[]): ParamValues {
  const out: ParamValues = {}
  for (const spec of specs) { if (isVisible(spec, values, specs) && values[spec.key] !== undefined) out[spec.key] = values[spec.key]! }
  return out
}

export function ParamsForm({ specs, values, onChange, idPrefix }: { specs: readonly ParamSpec[]; values: ParamValues; onChange: (next: ParamValues) => void; idPrefix: string }) {
  const set = (key: string, value: ParamValue): void => { onChange({ ...values, [key]: value }) }
  const unset = (key: string): void => { const next = { ...values }; delete next[key]; onChange(next) }
  const shown = specs.filter(spec => isVisible(spec, values, specs))
  if (shown.length === 0) return null
  return (
    <div className="st-params">
      {shown.map((spec) => {
        const id = `${idPrefix}-${spec.key}`
        const value = values[spec.key]
        switch (spec.type) {
          case 'enum':
            return <Select key={spec.key} id={id} label={spec.label} value={typeof value === 'string' ? value : (spec.default ?? spec.values[0] ?? '')} onChange={(v) => { set(spec.key, v) }} options={spec.values.map(v => ({ value: v, label: v }))} />
          case 'boolean':
            return <div key={spec.key} className="dk-field"><span className="dk-field__label">{spec.label}</span><div className="st-bool"><Switch label={spec.label} checked={typeof value === 'boolean' ? value : spec.default === true} onChange={(v) => { set(spec.key, v) }} /></div></div>
          case 'integer':
          case 'number': {
            // Very wide ranges (seeds) are an optional number field: empty means "let the provider choose".
            if (spec.max - spec.min > 100_000 && spec.default === undefined) {
              return <TextField key={spec.key} id={id} label={spec.label} type="number" inputMode="numeric" min={spec.min} max={spec.max} placeholder="Random" value={typeof value === 'number' ? String(value) : ''}
                onChange={(e) => { const raw = e.target.value.trim(); if (raw === '') unset(spec.key); else { const n = Math.floor(Number(raw)); if (Number.isFinite(n)) set(spec.key, Math.min(spec.max, Math.max(spec.min, n))) } }} />
            }
            const current = typeof value === 'number' ? value : (spec.default ?? spec.min)
            const step = spec.type === 'integer' ? 1 : (spec.step ?? (spec.max - spec.min) / 100)
            const span = spec.max - spec.min
            // Short integer ranges read better as a stepper; wide or fractional ranges as a slider with a value.
            return (
              <div key={spec.key} className="dk-field">
                <label className="dk-field__label" htmlFor={id}>{spec.label}: <b style={{ fontWeight: 600 }}>{current}</b></label>
                {span <= 12 && spec.type === 'integer'
                  ? <div className="st-row st-row--wrap">{Array.from({ length: span + 1 }, (_, i) => spec.min + i).map(n => <button key={n} type="button" className="st-chip" aria-pressed={current === n} onClick={() => { set(spec.key, n) }}>{n}</button>)}</div>
                  : <input id={id} className="st-range" type="range" min={spec.min} max={spec.max} step={step} value={current} onChange={(e) => { set(spec.key, spec.type === 'integer' ? Math.round(Number(e.target.value)) : Number(e.target.value)) }} />}
              </div>
            )
          }
          case 'text':
            return <TextField key={spec.key} id={id} label={spec.label} value={typeof value === 'string' ? value : (spec.default ?? '')} onChange={(e) => { set(spec.key, e.target.value) }} />
        }
      })}
    </div>
  )
}
