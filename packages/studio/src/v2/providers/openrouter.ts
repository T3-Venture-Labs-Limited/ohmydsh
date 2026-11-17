/**
 * OpenRouter adapter. Images: POST /api/v1/images (sync, base64). Video: POST /api/v1/videos (async, poll, authenticated download).
 * Catalog: curated presets (authoritative for params/pricing) + discovery from /images/models and /videos/models (24 h cache).
 * Wire facts verified against the OpenRouter docs fetched 2026-11-13 (see tests/v2/fixtures/openrouter).
 */
import { prepareInpaint, promptWith, type PreparedInpaint } from './inpaint.js'
import { AdapterError, type AdapterContext, type Capability, type ModelDescriptor, type OperationRequest, type ParamSpec, type PollResult, type Pricing, type ProducedFile, type ProviderAdapter, type SubmitResult } from '../contracts.js'
import { asArray, asNumber, asRecord, asString, classifyHttp, jsonRequest, toDataUrl } from './http.js'

export const OPENROUTER_BASE = 'https://openrouter.ai/api/v1'
export const CATALOG_TTL_MS = 24 * 60 * 60 * 1000

export interface CatalogCache { get(key: string): { fetchedAt: number; payload: string } | undefined; put(key: string, payload: string, now: number): void }

export interface OpenRouterOptions {
  apiKey(): Promise<string | undefined>
  fetch?: typeof fetch
  cache?: CatalogCache
  now?: () => number
  baseUrl?: string
  referer?: string
}

const ASPECTS_IMAGE = ['auto', '1:1', '3:2', '2:3', '4:3', '3:4', '4:5', '5:4', '16:9', '9:16', '21:9'] as const

const imageParams = (resolutions: readonly string[], extras: ParamSpec[] = []): ParamSpec[] => [
  { key: 'aspect_ratio', label: 'Aspect ratio', type: 'enum', values: ASPECTS_IMAGE, default: '1:1' },
  { key: 'resolution', label: 'Resolution', type: 'enum', values: resolutions, default: resolutions[0]! },
  { key: 'n', label: 'Images', type: 'integer', min: 1, max: 4, default: 1 },
  { key: 'seed', label: 'Seed', type: 'integer', min: 0, max: 2_147_483_647 },
  ...extras,
]

const IMAGE_PRESETS: readonly { remote: string; label: string; tier: 'quality' | 'value' | 'draft'; caps: Capability[]; maxRefs: number; res: readonly string[]; pricing: Pricing; extras?: ParamSpec[]; inpaintMode?: 'markup' }[] = [
  { remote: 'google/gemini-nano-banana-2.1', label: 'Nano Banana 2.1', tier: 'value', caps: ['t2i', 'i2i'], maxRefs: 14, res: ['1K', '2K', '4K'], pricing: { unit: 'image', usd: 0.0336, note: '1K; 2K ≈ $0.05, 4K ≈ $0.11' } },
  { remote: 'google/gemini-3-pro-image', label: 'Nano Banana Pro', tier: 'quality', caps: ['t2i', 'i2i'], maxRefs: 14, res: ['1K', '2K', '4K'], pricing: { unit: 'image', usd: 0.13, note: '1K; 4K ≈ $0.24' } },
  { remote: 'black-forest-labs/flux-3-image', label: 'FLUX 3 Image', tier: 'quality', caps: ['t2i', 'i2i'], maxRefs: 10, res: ['1K', '2K'], pricing: { unit: 'image', usd: 0.048, note: '≈ per 1K image' } },
  { remote: 'krea/k3-edit', label: 'Krea K3 Edit', tier: 'value', caps: ['i2i'], maxRefs: 8, res: ['1K', '2K'], pricing: { unit: 'image', usd: 0.05, note: '1K edit incl. input' } },
  { remote: 'openai/gpt-image-2.6-flare', label: 'GPT Image 2.6', tier: 'quality', caps: ['t2i', 'i2i', 'inpaint'], maxRefs: 16, res: ['1K', '2K'], pricing: { unit: 'image', usd: 0.13, note: 'high quality ≈ $0.13' }, inpaintMode: 'markup',
    extras: [{ key: 'quality', label: 'Quality', type: 'enum', values: ['auto', 'low', 'medium', 'high'], default: 'auto' }, { key: 'background', label: 'Background', type: 'enum', values: ['auto', 'transparent', 'opaque'], default: 'auto' }] },
  { remote: 'qwen/qwen-image-3', label: 'Qwen Image 3', tier: 'draft', caps: ['t2i', 'i2i'], maxRefs: 3, res: ['1K', '2K'], pricing: { unit: 'image', usd: 0.03, note: '1K output; each input image adds $0.003' } },
]

const videoParams = (spec: { durations: readonly number[]; resolutions: readonly string[]; aspects: readonly string[]; audio: boolean; seed: boolean }): ParamSpec[] => [
  ...(spec.durations.length > 0 ? [{ key: 'duration', label: 'Duration (s)', type: 'enum', values: spec.durations.map(String), default: String(spec.durations.find(d => d >= 4) ?? spec.durations[0]) } satisfies ParamSpec] : []),
  ...(spec.resolutions.length > 0 ? [{ key: 'resolution', label: 'Resolution', type: 'enum', values: spec.resolutions, default: spec.resolutions.includes('720p') ? '720p' : spec.resolutions[0]! } satisfies ParamSpec] : []),
  ...(spec.aspects.length > 0 ? [{ key: 'aspect_ratio', label: 'Aspect ratio', type: 'enum', values: spec.aspects, default: spec.aspects.includes('16:9') ? '16:9' : spec.aspects[0]! } satisfies ParamSpec] : []),
  ...(spec.audio ? [{ key: 'generate_audio', label: 'Generate audio', type: 'boolean', default: true } satisfies ParamSpec] : []),
  ...(spec.seed ? [{ key: 'seed', label: 'Seed', type: 'integer', min: 0, max: 2_147_483_647 } satisfies ParamSpec] : []),
]

interface RawVideoModel {
  id: string; name?: string; supported_resolutions?: string[] | null; supported_aspect_ratios?: string[] | null; supported_durations?: number[] | null
  supported_frame_images?: string[] | null; upscale_factor?: { min: number; max: number } | null; creativity?: [number, number] | null
  generate_audio?: boolean; seed?: boolean; pricing_skus?: Record<string, string> | null; description?: string
}

/** Cheapest published per-second price across SKUs (USD/s); `cents_per_*` keys are converted. */
export function videoPricing(skus: Record<string, string> | null | undefined, resolution?: string): Pricing | undefined {
  if (skus === undefined || skus === null) return undefined
  const entries = Object.entries(skus).map(([k, v]) => ({ key: k, usd: k.startsWith('cents_') ? Number(v) / 100 : Number(v), perSecond: k.includes('second') || k.startsWith('duration_seconds') || k.includes('per_second') })).filter(e => Number.isFinite(e.usd) && e.perSecond && !e.key.includes('megapixel'))
  if (entries.length === 0) {
    const mp = Object.entries(skus).filter(([k]) => k.includes('megapixel_second')).map(([k, v]) => ({ key: k, usd: k.startsWith('cents_') ? Number(v) / 100 : Number(v) })).filter(e => Number.isFinite(e.usd)).sort((a, b) => a.usd - b.usd)[0]
    return mp === undefined ? undefined : { unit: 'megapixel-second', usd: mp.usd, note: `from ${mp.key} (cheapest SKU)` }
  }
  const byRes = resolution === undefined ? undefined : entries.find(e => e.key.includes(resolution.toLowerCase()) && !e.key.includes('4k') === !resolution.toLowerCase().includes('4k') && !e.key.includes('without'))
  const chosen = byRes ?? entries.filter(e => !e.key.includes('without') && !e.key.includes('4k')).sort((a, b) => a.usd - b.usd)[0] ?? entries.sort((a, b) => a.usd - b.usd)[0]!
  const bySku: Record<string, number> = {}
  for (const e of entries) { const res = /(?:_|-)(\d{3,4}p|4k|2k|1k)(?:_|$)/i.exec(e.key)?.[1]?.toLowerCase(); if (res !== undefined && !e.key.includes('without')) bySku[res === '4k' ? '4K' : res] = e.usd }
  return { unit: 'second', usd: chosen.usd, note: `from published SKUs (${entries.map(e => `${e.key}=${e.usd}`).join(', ')})`, ...(Object.keys(bySku).length > 0 ? { byParam: { key: 'resolution', usd: bySku } } : {}) }
}

export function videoModelFromCatalog(raw: RawVideoModel, now: string): ModelDescriptor {
  const frames = raw.supported_frame_images ?? []
  const upscale = raw.upscale_factor !== null && raw.upscale_factor !== undefined
  const id = raw.id.toLowerCase()
  const edit = /(video-edit|aleph)/.test(id)
  const caps: Capability[] = upscale ? ['upscale-video'] : edit ? ['v2v'] : ['t2v', ...(frames.includes('first_frame') ? ['i2v' as const] : []), ...(frames.includes('first_frame') && frames.includes('last_frame') ? ['first-last-frame' as const] : []), ...(/(omni|seedance-2\.5|flux-3-video)/.test(id) ? ['extend' as const] : [])]
  const params: ParamSpec[] = upscale
    ? [{ key: 'upscale_factor', label: 'Upscale factor', type: 'number', min: raw.upscale_factor!.min, max: raw.upscale_factor!.max, step: 0.5, default: raw.upscale_factor!.min }, ...(raw.creativity ? [{ key: 'creativity', label: 'Creativity', type: 'number', min: raw.creativity[0], max: raw.creativity[1], step: 0.05, default: raw.creativity[0] } satisfies ParamSpec] : [])]
    : videoParams({ durations: raw.supported_durations ?? [], resolutions: raw.supported_resolutions ?? [], aspects: raw.supported_aspect_ratios ?? [], audio: raw.generate_audio === true, seed: raw.seed === true })
  const pricing = videoPricing(raw.pricing_skus)
  return {
    id: `openrouter:${raw.id}`, provider: 'openrouter', remoteId: raw.id, label: raw.name?.replace(/^[^:]+:\s*/, '') ?? raw.id, capabilities: caps,
    inputs: { ...(frames.length > 0 ? { images: { max: 2, roles: ['first', 'last'] as const } } : {}), ...(upscale || edit ? { video: { max: 1 } } : {}) },
    params, async: 'job', curated: false, verifiedAt: now, ...(pricing === undefined ? {} : { pricing }),
  }
}

interface RawImageModel { id: string; name?: string; architecture?: { input_modalities?: string[]; output_modalities?: string[] }; supported_parameters?: Record<string, { type: string; values?: string[]; min?: number; max?: number }> }

export function imageModelFromCatalog(raw: RawImageModel, now: string): ModelDescriptor | undefined {
  const sp = raw.supported_parameters ?? {}
  const refs = sp.input_references
  const maxRefs = refs?.type === 'range' ? refs.max ?? 0 : 0
  const accepts = raw.architecture?.input_modalities?.includes('image') === true && maxRefs > 0
  const caps: Capability[] = accepts ? ['t2i', 'i2i'] : ['t2i']
  const params: ParamSpec[] = []
  const ar = sp.aspect_ratio; if (ar?.values !== undefined) params.push({ key: 'aspect_ratio', label: 'Aspect ratio', type: 'enum', values: ar.values, default: ar.values.includes('1:1') ? '1:1' : ar.values[0]! })
  const res = sp.resolution; if (res?.values !== undefined) params.push({ key: 'resolution', label: 'Resolution', type: 'enum', values: res.values, default: res.values.includes('1K') ? '1K' : res.values[0]! })
  const q = sp.quality; if (q?.values !== undefined) params.push({ key: 'quality', label: 'Quality', type: 'enum', values: q.values, default: q.values.includes('auto') ? 'auto' : q.values[0]! })
  const n = sp.n; if (n?.type === 'range' && (n.max ?? 1) > 1) params.push({ key: 'n', label: 'Images', type: 'integer', min: 1, max: Math.min(4, n.max!), default: 1 })
  if (sp.seed !== undefined) params.push({ key: 'seed', label: 'Seed', type: 'integer', min: 0, max: 2_147_483_647 })
  if (sp.output_format !== undefined) params.push({ key: 'output_format', label: 'Format', type: 'enum', values: ['png', 'jpeg'], default: 'png' })
  const bg = sp.background; if (bg?.values !== undefined) params.push({ key: 'background', label: 'Background', type: 'enum', values: bg.values, default: bg.values.includes('auto') ? 'auto' : bg.values[0]! })
  return { id: `openrouter:${raw.id}`, provider: 'openrouter', remoteId: raw.id, label: raw.name?.replace(/^[^:]+:\s*/, '') ?? raw.id, capabilities: caps, inputs: accepts ? { images: { max: maxRefs, roles: ['ref', 'source'] } } : {}, params, async: 'sync', curated: false, verifiedAt: now }
}

const CURATED_VIDEO: readonly { remote: string; tier?: 'quality' | 'value' | 'draft'; label?: string }[] = [
  { remote: 'google/veo-3.1-fast', tier: 'quality', label: 'Veo 3.1 Fast' }, { remote: 'google/veo-3.1', tier: 'quality', label: 'Veo 3.1' },
  { remote: 'google/gemini-omni-1.2-flash', tier: 'value', label: 'Gemini Omni 1.2 Flash' }, { remote: 'alibaba/wan-3.0', tier: 'draft', label: 'Wan 3.0' },
  { remote: 'bytedance/seedance-2.0-mini', tier: 'draft', label: 'Seedance 2.0 Mini' }, { remote: 'black-forest-labs/flux-video-upscale', tier: 'value', label: 'FLUX Video Upscale' },
]

export class OpenRouterAdapter implements ProviderAdapter {
  readonly id = 'openrouter' as const
  private readonly fetchFn: typeof fetch
  private readonly base: string
  private memory: { at: number; models: ModelDescriptor[] } | undefined

  constructor(private readonly options: OpenRouterOptions) {
    this.fetchFn = options.fetch ?? fetch
    this.base = options.baseUrl ?? OPENROUTER_BASE
  }

  private now(): number { return (this.options.now ?? Date.now)() }

  async isConfigured(): Promise<boolean> { return (await this.options.apiKey()) !== undefined }

  private async key(): Promise<string> {
    const key = await this.options.apiKey()
    if (key === undefined) throw new AdapterError('auth', 'OpenRouter has no API key. Add OPENROUTER_API_KEY in Settings > Plugins > Studio.')
    return key
  }

  private headers(key: string): Record<string, string> {
    return { authorization: `Bearer ${key}`, 'content-type': 'application/json', 'x-title': 'Dsh Studio', ...(this.options.referer === undefined ? {} : { 'http-referer': this.options.referer }) }
  }

  // ---------------------------------------------------------------- catalog
  async listModels(options: { refresh?: boolean } = {}): Promise<readonly ModelDescriptor[]> {
    const now = this.now()
    if (options.refresh !== true && this.memory !== undefined && now - this.memory.at < CATALOG_TTL_MS) return this.memory.models
    const curated = this.curated()
    let discovered: ModelDescriptor[] = []
    try { discovered = await this.discover(options.refresh === true) } catch { /* curated list still works offline */ }
    const byId = new Map<string, ModelDescriptor>()
    for (const m of discovered) byId.set(m.id, m)
    for (const m of curated) {
      const found = byId.get(m.id)
      // Curated entries stay authoritative for capabilities and pricing; discovery supplies the live param lists when present.
      byId.set(m.id, found === undefined ? m : { ...found, ...m, params: m.curated ? mergeParams(m.params, found.params) : m.params })
    }
    const models = [...byId.values()].sort((a, b) => Number(b.curated) - Number(a.curated) || a.label.localeCompare(b.label))
    this.memory = { at: now, models }
    return models
  }

  private curated(): ModelDescriptor[] {
    const verified = '2026-11-13'
    const images = IMAGE_PRESETS.map((p): ModelDescriptor => ({
      id: `openrouter:${p.remote}`, provider: 'openrouter', remoteId: p.remote, label: p.label, capabilities: p.caps, tier: p.tier,
      inputs: p.caps.includes('i2i') ? { images: { max: p.maxRefs, roles: ['ref', 'source'] } } : {}, params: imageParams(p.res, p.extras), pricing: p.pricing,
      ...(p.inpaintMode === undefined ? {} : { inpaintMode: p.inpaintMode }), async: 'sync', curated: true, verifiedAt: verified,
    }))
    return images
  }

  private async discover(force: boolean): Promise<ModelDescriptor[]> {
    const now = this.now(); const stamp = new Date(now).toISOString().slice(0, 10)
    const out: ModelDescriptor[] = []
    for (const [kind, path] of [['images', '/images/models'], ['videos', '/videos/models']] as const) {
      const cacheKey = `openrouter:${kind}`
      let text: string | undefined
      const cached = this.options.cache?.get(cacheKey)
      if (!force && cached !== undefined && now - cached.fetchedAt < CATALOG_TTL_MS) text = cached.payload
      else {
        try {
          const response = await this.fetchFn(`${this.base}${path}`, { headers: { accept: 'application/json' } })
          if (!response.ok) throw classifyHttp(response.status, '')
          text = await response.text(); this.options.cache?.put(cacheKey, text, now)
        } catch (error) { if (cached === undefined) throw error; text = cached.payload }
      }
      const data = asArray(asRecord(JSON.parse(text)).data)
      for (const raw of data) {
        const model = kind === 'images' ? imageModelFromCatalog(raw as RawImageModel, stamp) : videoModelFromCatalog(raw as RawVideoModel, stamp)
        if (model !== undefined) out.push(model)
      }
    }
    // Curated video presets get tier/labels on top of discovered data.
    return out.map(m => { const c = CURATED_VIDEO.find(v => `openrouter:${v.remote}` === m.id); return c === undefined ? m : { ...m, curated: true, ...(c.tier === undefined ? {} : { tier: c.tier }), ...(c.label === undefined ? {} : { label: c.label }) } })
  }

  estimate(request: OperationRequest, model: ModelDescriptor): { usd?: number } | undefined {
    const p = model.pricing; if (p === undefined) return undefined
    if (p.unit === 'image') { const n = typeof request.params.n === 'number' ? request.params.n : 1; return { usd: Math.round(p.usd * n * 10_000) / 10_000 } }
    if (p.unit === 'second') {
      const duration = Number(request.params.duration); if (!Number.isFinite(duration)) return undefined
      const res = typeof request.params.resolution === 'string' ? request.params.resolution : undefined
      const rate = p.byParam !== undefined && res !== undefined ? p.byParam.usd[res] ?? p.usd : p.usd
      return { usd: Math.round(rate * duration * 10_000) / 10_000 }
    }
    return undefined
  }

  validate(request: OperationRequest, model: ModelDescriptor): { path: string; message: string }[] {
    const issues: { path: string; message: string }[] = []
    const refs = (request.inputs.references?.length ?? 0) + (request.inputs.source === undefined ? 0 : 1)
    const max = model.inputs.images?.max ?? 0
    if (refs > max) issues.push({ path: 'inputs', message: `${model.label} accepts at most ${String(max)} input image${max === 1 ? '' : 's'} (got ${String(refs)})` })
    if (model.async === 'sync' && request.op === 'generate' && (request.prompt ?? '').trim().length === 0) issues.push({ path: 'prompt', message: 'A prompt is required' })
    if (model.capabilities.includes('upscale-video') && request.inputs.video === undefined && request.inputs.source === undefined) issues.push({ path: 'inputs.video', message: 'Video upscaling needs a source video' })
    return issues
  }

  // ---------------------------------------------------------------- submit
  async submit(request: OperationRequest, model: ModelDescriptor, context: AdapterContext): Promise<SubmitResult> {
    const key = await this.key()
    return model.async === 'sync' ? this.submitImage(request, model, context, key) : this.submitVideo(request, model, context, key)
  }

  private async submitImage(request: OperationRequest, model: ModelDescriptor, context: AdapterContext, key: string): Promise<SubmitResult> {
    const refs = [...(request.inputs.source === undefined ? [] : [request.inputs.source]), ...(request.inputs.references ?? [])]
    const input_references: unknown[] = []
    const prepared: PreparedInpaint | undefined = request.op === 'inpaint' ? await prepareInpaint(request, model, context) : undefined
    for (const [i, ref] of refs.entries()) {
      const file = await context.readInput(ref)
      // overlay-prompt models get the tinted copy of the source in place of the original
      if (i === 0 && prepared?.overlaySource !== undefined) { input_references.push({ type: 'image_url', image_url: { url: toDataUrl(prepared.overlaySource, 'image/png') } }); continue }
      input_references.push({ type: 'image_url', image_url: { url: toDataUrl(file.bytes, file.mediaType) } })
    }
    const p = request.params
    const body: Record<string, unknown> = {
      model: model.remoteId, prompt: prepared === undefined ? request.prompt ?? '' : promptWith(request.prompt, prepared), ...(input_references.length > 0 ? { input_references } : {}),
      n: typeof p.n === 'number' ? p.n : 1,
      ...(typeof p.resolution === 'string' ? { resolution: p.resolution } : {}), ...(typeof p.aspect_ratio === 'string' && p.aspect_ratio !== 'auto' ? { aspect_ratio: p.aspect_ratio } : p.aspect_ratio === 'auto' ? { aspect_ratio: 'auto' } : {}),
      ...(typeof p.quality === 'string' ? { quality: p.quality } : {}), ...(typeof p.background === 'string' ? { background: p.background } : {}),
      ...(typeof p.seed === 'number' ? { seed: p.seed } : {}),
      // Only models that declare the parameter accept it (FLUX 3 answers 400 otherwise): the catalog tells us.
      ...(model.params.some(x => x.key === 'output_format') ? { output_format: 'png' } : {}),
    }
    // markup mode (gpt-image): a transparent PNG with the same size as the first reference marks where the edit applies
    if (prepared?.markup !== undefined) body.markup = { type: 'image_url', image_url: { url: toDataUrl(prepared.markup, 'image/png') } }
    const { json } = await jsonRequest(context.fetch, `${this.base}/images`, { method: 'POST', headers: this.headers(key), body: JSON.stringify(body), signal: context.signal, secrets: [key] })
    const record = asRecord(json)
    const outputs: ProducedFile[] = []
    for (const item of asArray(record.data)) {
      const row = asRecord(item); const b64 = asString(row.b64_json)
      if (b64 === undefined) continue
      outputs.push({ bytes: new Uint8Array(Buffer.from(b64, 'base64')), mediaType: asString(row.media_type) ?? 'image/png', ...(typeof body.seed === 'number' ? { seed: body.seed } : {}) })
    }
    if (outputs.length === 0) throw new AdapterError('invalid', 'OpenRouter returned no image data')
    const cost = asNumber(asRecord(record.usage).cost)
    return { kind: 'done', outputs, ...(cost === undefined ? {} : { cost: { usd: cost, source: 'provider' as const } }) }
  }

  private async submitVideo(request: OperationRequest, model: ModelDescriptor, context: AdapterContext, key: string): Promise<SubmitResult> {
    const p = request.params
    const body: Record<string, unknown> = { model: model.remoteId, prompt: request.prompt ?? '' }
    if (p.duration !== undefined) body.duration = Number(p.duration)
    if (typeof p.resolution === 'string') body.resolution = p.resolution
    if (typeof p.aspect_ratio === 'string') body.aspect_ratio = p.aspect_ratio
    if (typeof p.generate_audio === 'boolean') body.generate_audio = p.generate_audio
    if (typeof p.seed === 'number') body.seed = p.seed
    const frame_images: unknown[] = []
    for (const [ref, frameType] of [[request.inputs.firstFrame ?? (request.op === 'animate' ? request.inputs.source : undefined), 'first_frame'], [request.inputs.lastFrame, 'last_frame']] as const) {
      if (ref === undefined) continue
      const file = await context.readInput(ref)
      frame_images.push({ type: 'image_url', image_url: { url: toDataUrl(file.bytes, file.mediaType) }, frame_type: frameType })
    }
    if (frame_images.length > 0) body.frame_images = frame_images
    else if ((request.inputs.references?.length ?? 0) > 0) {
      body.input_references = await Promise.all((request.inputs.references ?? []).map(async ref => { const f = await context.readInput(ref); return { type: 'image_url', image_url: { url: toDataUrl(f.bytes, f.mediaType) } } }))
    }
    if (model.capabilities.includes('upscale-video')) {
      if (typeof p.upscale_factor === 'number') body.upscale_factor = p.upscale_factor
      if (typeof p.creativity === 'number') body.creativity = p.creativity
    }
    const sourceVideo = request.inputs.video ?? (model.capabilities.some(c => c === 'upscale-video' || c === 'v2v') ? request.inputs.source : undefined)
    if (sourceVideo !== undefined) {
      // OpenRouter accepts video inputs only as public HTTPS URLs (verified live 2026-11-14: data URLs are rejected with 400).
      // The signed URL OpenRouter returns for a job it ran is the only hosted copy we have; for any other clip use Replicate.
      const url = context.publicUrl?.(sourceVideo)
      if (url === undefined) throw new AdapterError('unsupported', `${model.label} needs the source video at a public HTTPS URL, which Studio only has for clips OpenRouter generated within the last hour. Use a Replicate video model (it accepts local files), or re-run the upscale soon after generating the clip.`)
      body.input_references = [{ type: 'video_url', video_url: { url } }]
    }
    const { json } = await jsonRequest(context.fetch, `${this.base}/videos`, { method: 'POST', headers: this.headers(key), body: JSON.stringify(body), signal: context.signal, secrets: [key] })
    const record = asRecord(json)
    const id = asString(record.id)
    if (id === undefined) throw new AdapterError('invalid', 'OpenRouter did not return a video job id')
    return { kind: 'remote', remote: { id, pollingUrl: asString(record.polling_url) ?? `${this.base}/videos/${id}` }, pollAfterMs: 10_000 }
  }

  // ---------------------------------------------------------------- poll
  async poll(remote: Readonly<Record<string, unknown>>, _model: ModelDescriptor, context: AdapterContext): Promise<PollResult> {
    const key = await this.key()
    const url = asString(remote.pollingUrl) ?? `${this.base}/videos/${String(remote.id)}`
    if (!url.startsWith(this.base)) throw new AdapterError('invalid', 'Refusing to poll a URL outside the OpenRouter API')
    const { json } = await jsonRequest(context.fetch, url, { method: 'GET', headers: this.headers(key), signal: context.signal, secrets: [key] })
    const record = asRecord(json)
    const status = asString(record.status) ?? 'pending'
    if (status === 'completed') {
      const urls = asArray(record.unsigned_urls).filter((u): u is string => typeof u === 'string')
      if (urls.length === 0) return { state: 'failed', error: new AdapterError('invalid', 'The video job completed without output URLs') }
      const cost = asNumber(asRecord(record.usage).cost)
      const signed = asArray(record.urls).filter((u): u is string => typeof u === 'string')
      const declared = typeof record.expires_at === 'string' ? Date.parse(record.expires_at) : typeof record.expires_at === 'number' ? record.expires_at * (record.expires_at < 1e12 ? 1000 : 1) : undefined
      return { state: 'done', outputs: urls.map((u, i) => ({ url: u, headers: { authorization: `Bearer ${key}` }, mediaType: 'video/mp4', ...(signed[i] === undefined ? {} : { meta: { publicUrl: signed[i], ...(expiryOf(signed[i]!, declared) === undefined ? {} : { expiresAt: expiryOf(signed[i]!, declared)! }) } }) })), ...(cost === undefined ? {} : { cost: { usd: cost, source: 'provider' as const } }) }
    }
    if (status === 'failed' || status === 'cancelled' || status === 'expired') {
      const message = asString(record.error) ?? asString(asRecord(record.error).message) ?? `Video job ${status}`
      return { state: 'failed', error: new AdapterError(/moderat|safety|policy|blocked/i.test(message) ? 'moderation' : 'unknown', message) }
    }
    return { state: status === 'in_progress' ? 'running' : 'queued', message: status === 'in_progress' ? 'Rendering' : 'Waiting in queue', pollAfterMs: 15_000 }
  }

  async cancel(): Promise<void> { /* OpenRouter documents no video cancel endpoint: the local job is abandoned and the result ignored. */ }
}

/** Constraint parameters the provider is authoritative for: a generic curated list must never offer a value the model rejects. */
const DISCOVERED_WINS = new Set(['aspect_ratio', 'resolution', 'n', 'output_format', 'duration'])
/** Curated params describe intent (labels, defaults, extras); live discovery overrides the allowed values and drops params the model does not accept. */
export function mergeParams(curated: readonly ParamSpec[], discovered: readonly ParamSpec[]): ParamSpec[] {
  if (discovered.length === 0) return [...curated]
  const live = new Map(discovered.map(p => [p.key, p]))
  const out: ParamSpec[] = []
  for (const spec of curated) {
    if (!DISCOVERED_WINS.has(spec.key)) { out.push(spec); continue }
    const found = live.get(spec.key)
    if (found === undefined) continue                    // model does not accept it (e.g. gpt-image has no resolution): do not offer it
    out.push(spec.type === 'enum' && found.type === 'enum'
      ? { ...spec, values: found.values, ...(spec.default !== undefined && found.values.includes(spec.default) ? {} : { default: found.default ?? found.values[0]! }) }
      : found)
  }
  const have = new Set(out.map(p => p.key))
  for (const spec of discovered) if (!have.has(spec.key) && !curated.some(c => c.key === spec.key) && ['background', 'quality', 'output_format', 'seed'].includes(spec.key)) out.push(spec)
  return out
}

/** Expiry of a signed URL: the response's expires_at when present, else the Google-style X-Goog-Date + X-Goog-Expires, else AWS-style X-Amz-Date + X-Amz-Expires. */
export function expiryOf(url: string, declared?: number): number | undefined {
  if (declared !== undefined && !Number.isNaN(declared)) return declared
  try {
    const q = new URL(url).searchParams
    for (const [dateKey, expKey] of [['X-Goog-Date', 'X-Goog-Expires'], ['X-Amz-Date', 'X-Amz-Expires']] as const) {
      const d = q.get(dateKey); const e = Number(q.get(expKey))
      const m = d === null ? null : /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(d)
      if (m !== null && Number.isFinite(e) && e > 0) return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6])) + e * 1000
    }
  } catch { /* not a URL */ }
  return undefined
}
