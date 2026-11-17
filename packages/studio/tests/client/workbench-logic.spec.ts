import { describe, expect, it } from 'vitest'
import { buildRequest, compatibleModels, missingInputs, neededCapabilities, slotsFor } from '../../src/client/workbench/caps.js'
import { carryOver, defaultsFor, isVisible, visibleValues } from '../../src/client/workbench/params-form.js'
import { parseToolText } from '../../src/client/workbench/tool-card.js'
import { STYLES, STYLE_CATEGORIES } from '../../src/client/workbench/styles-data.js'
import { t } from '../../src/client/workbench/i18n.js'
import { matches } from '../../src/client/workbench/gallery-data.js'
import { usd, ago } from '../../src/client/workbench/format.js'
import type { AssetRecord, ModelDescriptor, ParamSpec } from '../../src/client/workbench/types.js'

const asset = (id: string, kind: 'image' | 'video' = 'image'): AssetRecord => ({ id, sha256: 'x', kind, ext: 'png', mime: 'image/png', bytes: 1, createdAt: 1, source: 'generated', favorite: false, tags: [] })
const model = (id: string, capabilities: ModelDescriptor['capabilities'], params: ParamSpec[] = []): ModelDescriptor => ({ id, provider: 'openrouter', remoteId: id, label: id, capabilities, inputs: {}, params, async: 'sync', curated: true })

describe('capability routing', () => {
  it('maps operations and inputs to needed capabilities like the host', () => {
    expect(neededCapabilities('image', 'generate', {})).toEqual(['t2i'])
    expect(neededCapabilities('image', 'generate', { references: [asset('a1234567')] })).toEqual(['i2i'])
    expect(neededCapabilities('video', 'animate', { firstFrame: [asset('a1234567')] })).toEqual(['i2v'])
    expect(neededCapabilities('video', 'animate', { firstFrame: [asset('a1234567')], lastFrame: [asset('b1234567')] })).toEqual(['first-last-frame'])
    expect(neededCapabilities('video', 'generate', {})).toEqual(['t2v'])
    expect(neededCapabilities('video', 'upscale', {})).toEqual(['upscale-video'])
  })
  it('filters models by kind and capability', () => {
    const models = [model('a', ['t2i']), model('b', ['t2i', 'i2i']), model('c', ['t2v', 'i2v']), model('d', ['upscale-image'])]
    expect(compatibleModels(models, 'image', 'generate', {}).map(m => m.id)).toEqual(['a', 'b'])
    expect(compatibleModels(models, 'image', 'edit', {}).map(m => m.id)).toEqual(['b'])
    expect(compatibleModels(models, 'video', 'animate', {}).map(m => m.id)).toEqual(['c'])
    expect(compatibleModels(models, 'image', 'upscale', {}).map(m => m.id)).toEqual(['d'])
  })
  it('requires the right tray slots', () => {
    expect(missingInputs('image', 'generate', {})).toEqual([])
    expect(missingInputs('image', 'edit', {}).map(s => s.key)).toEqual(['source'])
    expect(missingInputs('video', 'animate', {}).map(s => s.key)).toEqual(['firstFrame'])
    expect(slotsFor('video', 'restyle').map(s => s.key)).toEqual(['video'])
  })
  it('builds the host request body with asset ids only', () => {
    const body = buildRequest({ kind: 'video', op: 'animate', modelId: 'openrouter:m', prompt: ' go ', negativePrompt: '', params: { duration: '3' }, inputs: { firstFrame: [asset('a1234567', 'image')] } })
    expect(body).toEqual({ op: 'animate', modelId: 'openrouter:m', prompt: 'go', inputs: { firstFrame: { assetId: 'a1234567' } }, params: { duration: '3' } })
    const edit = buildRequest({ kind: 'image', op: 'edit', modelId: 'openrouter:m', prompt: 'x', negativePrompt: 'bad', params: {}, inputs: { source: [asset('s1234567')], references: [asset('r1234567')] } })
    expect(edit).toMatchObject({ inputs: { source: { assetId: 's1234567' }, references: [{ assetId: 'r1234567' }] }, negativePrompt: 'bad' })
  })
})

describe('ParamSpec form logic', () => {
  const specs: ParamSpec[] = [
    { key: 'mode', label: 'Mode', type: 'enum', values: ['a', 'b'], default: 'a' },
    { key: 'extra', label: 'Extra', type: 'integer', min: 1, max: 4, default: 2, when: { key: 'mode', in: ['b'] } },
    { key: 'seed', label: 'Seed', type: 'integer', min: 0, max: 100 },
  ]
  it('applies defaults and gates by `when`', () => {
    const values = defaultsFor(specs)
    expect(values).toEqual({ mode: 'a', extra: 2 })
    expect(isVisible(specs[1]!, values, specs)).toBe(false)
    expect(isVisible(specs[1]!, { ...values, mode: 'b' }, specs)).toBe(true)
    expect(visibleValues(values, specs)).toEqual({ mode: 'a' })
  })
  it('carries compatible values across models and drops the rest', () => {
    const next: ParamSpec[] = [{ key: 'mode', label: 'Mode', type: 'enum', values: ['a', 'c'], default: 'c' }, { key: 'seed', label: 'Seed', type: 'integer', min: 0, max: 10 }]
    expect(carryOver({ mode: 'b', seed: 5, gone: 1 }, next)).toEqual({ mode: 'c', seed: 5 })
    expect(carryOver({ mode: 'a', seed: 50 }, next)).toEqual({ mode: 'a' })
  })
})

describe('tool card parsing', () => {
  it('finds a job id and asset ids in tool text without false positives', () => {
    const text = 'Job job_01M7B3RXKN1CFCH9Z9J57RRACV started on mischief 1.\nassets: 01M7B3SZM4VBSG0G15RW64YC3Q, 01M7B41EC6BHM17FERMT5BVCMV'
    expect(parseToolText(text)).toEqual({ jobId: 'job_01M7B3RXKN1CFCH9Z9J57RRACV', assetIds: ['01M7B3SZM4VBSG0G15RW64YC3Q', '01M7B41EC6BHM17FERMT5BVCMV'] })
    expect(parseToolText('No Studio jobs yet.')).toEqual({ jobId: undefined, assetIds: [] })
  })
})

describe('styles library', () => {
  it('ships ~30 curated, unique, text-only styles that use the {subject} slot', () => {
    expect(STYLES.length).toBeGreaterThanOrEqual(28)
    expect(new Set(STYLES.map(s => s.id)).size).toBe(STYLES.length)
    for (const style of STYLES) {
      expect(style.prompt).toContain('{subject}')
      expect(STYLE_CATEGORIES).toContain(style.category)
      expect(style.prompt).not.toMatch(/https?:\/\//)
    }
  })
})

describe('misc', () => {
  it('fills i18n placeholders', () => { expect(t('selectedN', { n: 3 })).toBe('3 selected') })
  it('formats money and time', () => {
    expect(usd(0.0485)).toBe('$0.05'); expect(usd(0.005)).toBe('$0.0050'); expect(usd(0)).toBe('$0'); expect(usd(undefined)).toBe('n/a')
    expect(ago(1000, 1000 + 7200_000)).toBe('2 h ago')
  })
  it('live-inserts only assets that fit the unfiltered/simple filters', () => {
    expect(matches(asset('a1234567'), {})).toBe(true)
    expect(matches(asset('a1234567', 'video'), { kind: 'image' })).toBe(false)
    expect(matches(asset('a1234567'), { favorite: true })).toBe(false)
    expect(matches(asset('a1234567'), { q: 'boat' })).toBe(false)
  })
})

import { maskWarning, clampPoint } from '../../src/client/workbench/mask-canvas.js'
import { inpaintModels, modeHint } from '../../src/client/workbench/mask-editor.js'

describe('mask editor logic', () => {
  it('warns exactly where the host refuses', () => {
    expect(maskWarning(0)).toBe('empty')
    expect(maskWarning(0.5)).toBeUndefined()
    expect(maskWarning(0.99)).toBe('full')
  })
  it('clamps pointer positions into the image', () => {
    expect(clampPoint(-5, 2000, 100, 50)).toEqual([0, 50])
  })
  it('lists inpaint-capable models, configured providers first, cheapest first', () => {
    const a = { ...model('openrouter:a', ['inpaint']), pricing: { unit: 'image' as const, usd: 0.13 } }
    const b = { ...model('replicate:b', ['inpaint']), provider: 'replicate' as const, pricing: { unit: 'image' as const, usd: 0.05 } }
    const c = model('openrouter:c', ['t2i'])
    expect(inpaintModels([a, b, c], { openrouter: true, replicate: false }).map(m => m.id)).toEqual(['openrouter:a', 'replicate:b'])
    expect(inpaintModels([a, b], { openrouter: true, replicate: true }).map(m => m.id)).toEqual(['replicate:b', 'openrouter:a'])
  })
  it('explains how each model receives the mask', () => {
    expect(modeHint({ ...model('x', ['inpaint']), inpaintMode: 'markup' })).toMatch(/overlay/)
    expect(modeHint({ ...model('x', ['inpaint']), inpaintMode: 'overlay-prompt' })).toMatch(/pasted back/)
    expect(modeHint(model('x', ['inpaint']))).toMatch(/mask directly/)
  })
})
