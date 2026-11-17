/**
 * Replicate adapter (official models only by default; community slugs via the user-pinned list).
 * Create: POST /v1/models/{owner}/{name}/predictions with `Prefer: wait=N` and `Cancel-After`; otherwise poll urls.get.
 * Outputs are HTTPS URLs on replicate.delivery that expire after ~1 h and need the bearer token: the runner downloads them immediately.
 * Per-model input shapes and mask polarity come from the curated presets below (verified against replicate.com model pages 2026-11-13).
 */
import { AdapterError, type AdapterContext, type AssetRef, type Capability, type ModelDescriptor, type OperationRequest, type ParamSpec, type PollResult, type Pricing, type ProducedFile, type ProviderAdapter, type SubmitResult, type MaskPolarity } from '../contracts.js'
import { prepareInpaint, promptWith } from './inpaint.js'
import { asArray, asNumber, asRecord, asString, classifyHttp, jsonRequest, toDataUrl } from './http.js'

export const REPLICATE_BASE = 'https://api.replicate.com/v1'
const DATA_URI_LIMIT = 256 * 1024

type Files = { source?: string; refs: string[]; mask?: string; first?: string; last?: string; video?: string }
type Mapper = (request: OperationRequest, files: Files, params: Readonly<Record<string, string | number | boolean>>) => Record<string, unknown>

interface Preset {
  remote: string; label: string; tier: 'quality' | 'value' | 'draft'; caps: Capability[]; async: 'sync' | 'job'
  inputs: ModelDescriptor['inputs']; params: ParamSpec[]; pricing: Pricing; map: Mapper
  maskPolarity?: MaskPolarity; inpaintMode?: 'mask'; maxDurationS?: number
}

const AR_COMMON = ['1:1', '3:2', '2:3', '4:3', '3:4', '16:9', '9:16', '21:9'] as const
const ar = (values: readonly string[] = AR_COMMON, extra: readonly string[] = []): ParamSpec => ({ key: 'aspect_ratio', label: 'Aspect ratio', type: 'enum', values: [...extra, ...values], default: extra[0] ?? '1:1' })
const seed: ParamSpec = { key: 'seed', label: 'Seed', type: 'integer', min: 0, max: 2_147_483_647 }
const common = (p: Readonly<Record<string, string | number | boolean>>): Record<string, unknown> => ({ ...(typeof p.seed === 'number' ? { seed: p.seed } : {}) })

export const REPLICATE_PRESETS: readonly Preset[] = [
  { remote: 'black-forest-labs/flux-3-image', label: 'FLUX 3 Image', tier: 'quality', caps: ['t2i', 'i2i'], async: 'sync', inputs: { images: { max: 10, roles: ['ref', 'source'] } },
    params: [ar(AR_COMMON, ['auto']), { key: 'resolution', label: 'Resolution', type: 'enum', values: ['768px', '1K', '1.5K', '2K'], default: '1K' }, seed], pricing: { unit: 'image', usd: 0.048, note: '1K; 2K $0.10' },
    map: (r, f, p) => ({ prompt: r.prompt ?? '', ...(f.source !== undefined || f.refs.length > 0 ? { images: [...(f.source === undefined ? [] : [f.source]), ...f.refs] } : {}), aspect_ratio: p.aspect_ratio ?? 'auto', ...(p.resolution === undefined ? {} : { resolution: p.resolution }), output_format: 'png', ...common(p) }) },
  { remote: 'google/nano-banana-pro', label: 'Nano Banana Pro (Replicate)', tier: 'quality', caps: ['t2i', 'i2i'], async: 'sync', inputs: { images: { max: 14, roles: ['ref', 'source'] } },
    params: [ar(), { key: 'resolution', label: 'Resolution', type: 'enum', values: ['1K', '2K', '4K'], default: '2K' }], pricing: { unit: 'image', usd: 0.15, note: '1K/2K; 4K $0.30' },
    map: (r, f, p) => ({ prompt: r.prompt ?? '', ...(f.source !== undefined || f.refs.length > 0 ? { image_input: [...(f.source === undefined ? [] : [f.source]), ...f.refs] } : {}), aspect_ratio: p.aspect_ratio ?? '1:1', resolution: p.resolution ?? '2K', output_format: 'png' }) },
  { remote: 'krea/krea-3', label: 'Krea 3 (edit)', tier: 'value', caps: ['t2i', 'i2i'], async: 'sync', inputs: { images: { max: 8, roles: ['ref', 'source'] } },
    params: [ar(), { key: 'resolution', label: 'Resolution', type: 'enum', values: ['1K', '2K'], default: '1K' }, { key: 'thinking_mode', label: 'Thinking mode', type: 'enum', values: ['fast', 'high'], default: 'fast' }, seed], pricing: { unit: 'image', usd: 0.03, note: '1K fast; high $0.05; 2K $0.06' },
    map: (r, f, p) => ({ prompt: r.prompt ?? '', ...(r.negativePrompt === undefined ? {} : { negative_prompt: r.negativePrompt }), ...(f.source !== undefined || f.refs.length > 0 ? { images: [...(f.source === undefined ? [] : [f.source]), ...f.refs] } : {}), aspect_ratio: p.aspect_ratio ?? '1:1', resolution: p.resolution ?? '1K', thinking_mode: p.thinking_mode ?? 'fast', ...common(p) }) },
  { remote: 'black-forest-labs/flux-fill-pro', label: 'FLUX Fill Pro (inpaint)', tier: 'quality', caps: ['inpaint'], async: 'sync', inputs: { images: { max: 2, roles: ['source', 'mask'] } },
    params: [{ key: 'steps', label: 'Steps', type: 'integer', min: 15, max: 50, default: 50 }, { key: 'guidance', label: 'Guidance', type: 'number', min: 1.5, max: 100, default: 60 }, { key: 'prompt_upsampling', label: 'Prompt upsampling', type: 'boolean', default: false }, seed], pricing: { unit: 'image', usd: 0.05 },
    maskPolarity: 'white-edit', inpaintMode: 'mask',
    map: (r, f, p) => ({ image: f.source, mask: f.mask, prompt: r.prompt ?? '', steps: p.steps ?? 50, guidance: p.guidance ?? 60, prompt_upsampling: p.prompt_upsampling ?? false, output_format: 'png', ...common(p) }) },
  { remote: 'ideogram-ai/ideogram-4-5-precise-edit', label: 'Ideogram 4.5 Precise Edit (inpaint)', tier: 'value', caps: ['inpaint'], async: 'sync', inputs: { images: { max: 3, roles: ['source', 'mask', 'ref'] } },
    params: [{ key: 'quality', label: 'Quality', type: 'enum', values: ['low', 'medium', 'high'], default: 'low' }], pricing: { unit: 'image', usd: 0.03, note: 'low; medium $0.06, high $0.22' },
    maskPolarity: 'black-edit', inpaintMode: 'mask',
    map: (r, f, p) => ({ image: f.source, mask: f.mask, prompt: r.prompt ?? '', quality: p.quality ?? 'low', ...(f.refs.length > 0 ? { reference_images: f.refs.slice(0, 3) } : {}) }) },
  { remote: 'bria/genfill', label: 'Bria GenFill (inpaint)', tier: 'value', caps: ['inpaint'], async: 'sync', inputs: { images: { max: 2, roles: ['source', 'mask'] } },
    params: [], pricing: { unit: 'image', usd: 0.04 }, maskPolarity: 'white-edit', inpaintMode: 'mask',
    map: (r, f) => ({ image: f.source, mask: f.mask, prompt: r.prompt ?? '', ...(r.negativePrompt === undefined ? {} : { negative_prompt: r.negativePrompt }) }) },
  { remote: 'bria/increase-resolution', label: 'Bria Increase Resolution (2×/4×)', tier: 'value', caps: ['upscale-image'], async: 'sync', inputs: { images: { max: 1, roles: ['source'] } },
    params: [{ key: 'desired_increase', label: 'Increase', type: 'enum', values: ['2', '4'], default: '2' }], pricing: { unit: 'image', usd: 0.04 },
    map: (_r, f, p) => ({ image: f.source, desired_increase: Number(p.desired_increase ?? 2) }) },
  { remote: 'topazlabs/image-upscale', label: 'Topaz Image Upscale', tier: 'quality', caps: ['upscale-image'], async: 'sync', inputs: { images: { max: 1, roles: ['source'] } },
    params: [{ key: 'enhance_model', label: 'Model', type: 'enum', values: ['Standard V2', 'Low Resolution V2', 'CGI', 'High Fidelity V2', 'Text Refine'], default: 'Standard V2' }, { key: 'upscale_factor', label: 'Factor', type: 'enum', values: ['2x', '4x', '6x'], default: '2x' }], pricing: { unit: 'image', usd: 0.05, note: 'from $0.05, tiered by megapixels' },
    map: (_r, f, p) => ({ image: f.source, enhance_model: p.enhance_model ?? 'Standard V2', upscale_factor: p.upscale_factor ?? '2x', output_format: 'png' }) },
  { remote: 'google/veo-3.1-fast', label: 'Veo 3.1 Fast (Replicate)', tier: 'quality', caps: ['t2v', 'i2v', 'first-last-frame'], async: 'job', inputs: { images: { max: 2, roles: ['first', 'last'] } }, maxDurationS: 8,
    params: [{ key: 'duration', label: 'Duration (s)', type: 'enum', values: ['4', '6', '8'], default: '4' }, { key: 'resolution', label: 'Resolution', type: 'enum', values: ['720p', '1080p'], default: '720p' }, ar(['16:9', '9:16'], []), { key: 'generate_audio', label: 'Generate audio', type: 'boolean', default: true }, seed],
    pricing: { unit: 'second', usd: 0.15, note: 'with audio; $0.10/s without' },
    map: (r, f, p) => ({ prompt: r.prompt ?? '', ...(f.first === undefined ? {} : { image: f.first }), ...(f.last === undefined ? {} : { last_frame: f.last }), ...(r.negativePrompt === undefined ? {} : { negative_prompt: r.negativePrompt }), duration: Number(p.duration ?? 4), resolution: p.resolution ?? '720p', aspect_ratio: p.aspect_ratio ?? '16:9', generate_audio: p.generate_audio ?? true, ...common(p) }) },
  { remote: 'kwaivgi/kling-v4-flash', label: 'Kling v4 Flash', tier: 'draft', caps: ['t2v', 'i2v', 'first-last-frame'], async: 'job', inputs: { images: { max: 2, roles: ['first', 'last'] } }, maxDurationS: 15,
    params: [{ key: 'duration', label: 'Duration (s)', type: 'enum', values: ['3', '5', '8', '10'], default: '5' }, { key: 'resolution', label: 'Resolution', type: 'enum', values: ['720p', '1080p'], default: '720p' }, ar(['16:9', '9:16', '1:1'], [])], pricing: { unit: 'second', usd: 0.094, note: '720p' },
    map: (r, f, p) => ({ prompt: r.prompt ?? '', ...(f.first === undefined ? {} : { start_image: f.first }), ...(f.last === undefined ? {} : { end_image: f.last }), duration: Number(p.duration ?? 5), resolution: p.resolution ?? '720p', aspect_ratio: p.aspect_ratio ?? '16:9' }) },
  { remote: 'wan-video/wan-2.7-videoedit', label: 'Wan 2.7 Video Edit', tier: 'value', caps: ['v2v'], async: 'job', inputs: { video: { max: 1 }, images: { max: 1, roles: ['ref'] } }, maxDurationS: 10,
    params: [{ key: 'resolution', label: 'Resolution', type: 'enum', values: ['720p', '1080p'], default: '720p' }], pricing: { unit: 'second', usd: 0.1, note: '720p' },
    map: (r, f, p) => ({ video: f.video, prompt: r.prompt ?? '', ...(f.refs[0] === undefined ? {} : { reference_image: f.refs[0] }), resolution: p.resolution ?? '720p' }) },
  { remote: 'xai/grok-imagine-video-extension', label: 'Grok Imagine Video Extension', tier: 'value', caps: ['extend'], async: 'job', inputs: { video: { max: 1 } }, maxDurationS: 15,
    params: [{ key: 'duration', label: 'Extend by (s)', type: 'enum', values: ['3', '5', '8', '10'], default: '5' }], pricing: { unit: 'second', usd: 0.05 },
    map: (r, f, p) => ({ video: f.video, prompt: r.prompt ?? '', duration: Number(p.duration ?? 5) }) },
  { remote: 'topazlabs/video-upscale', label: 'Topaz Video Upscale', tier: 'quality', caps: ['upscale-video'], async: 'job', inputs: { video: { max: 1 } },
    params: [{ key: 'target_resolution', label: 'Target resolution', type: 'enum', values: ['720p', '1080p', '4k'], default: '1080p' }, { key: 'target_fps', label: 'Target FPS', type: 'integer', min: 15, max: 60, default: 30 }], pricing: { unit: 'run', usd: 0.093, note: '≈ per 5 s, 720p→1080p/30 fps' },
    map: (_r, f, p) => ({ video: f.video, target_resolution: p.target_resolution ?? '1080p', target_fps: p.target_fps ?? 30 }) },
]

export interface ReplicateOptions {
  apiToken(): Promise<string | undefined>
  fetch?: typeof fetch
  baseUrl?: string
  /** User-pinned extra slugs (official or community); shown as generic prompt+image models without param knowledge. */
  pinned?(): readonly string[]
  /** `Prefer: wait` seconds for sync-capable models (1-60). */
  waitSeconds?: number
  /** Hard server-side deadline for a prediction (`Cancel-After`). */
  cancelAfter?: string
}

export class ReplicateAdapter implements ProviderAdapter {
  readonly id = 'replicate' as const
  private readonly base: string
  constructor(private readonly options: ReplicateOptions) { this.base = options.baseUrl ?? REPLICATE_BASE }

  async isConfigured(): Promise<boolean> { return (await this.options.apiToken()) !== undefined }
  private async token(): Promise<string> {
    const t = await this.options.apiToken()
    if (t === undefined) throw new AdapterError('auth', 'Replicate has no API token. Add REPLICATE_API_TOKEN in Settings > Plugins > Studio.')
    return t
  }

  async listModels(): Promise<readonly ModelDescriptor[]> {
    const curated = REPLICATE_PRESETS.map((p): ModelDescriptor => ({
      id: `replicate:${p.remote}`, provider: 'replicate', remoteId: p.remote, label: p.label, capabilities: p.caps, inputs: p.inputs, params: p.params, pricing: p.pricing, async: p.async, curated: true, tier: p.tier, verifiedAt: '2026-11-13',
      ...(p.maskPolarity === undefined ? {} : { maskPolarity: p.maskPolarity }), ...(p.inpaintMode === undefined ? {} : { inpaintMode: p.inpaintMode }), ...(p.maxDurationS === undefined ? {} : { limits: { maxDurationS: p.maxDurationS } }),
    }))
    const pinned = (this.options.pinned?.() ?? []).filter(slug => /^[a-z0-9][\w.-]*\/[\w.-]+$/i.test(slug) && !REPLICATE_PRESETS.some(p => p.remote === slug)).map((slug): ModelDescriptor => ({
      id: `replicate:${slug}`, provider: 'replicate', remoteId: slug, label: slug, capabilities: ['t2i'], inputs: {}, params: [seed], async: 'sync', curated: false,
    }))
    return [...curated, ...pinned]
  }

  estimate(request: OperationRequest, model: ModelDescriptor): { usd?: number } | undefined {
    const p = model.pricing; if (p === undefined) return undefined
    if (p.unit === 'image' || p.unit === 'run') return { usd: p.usd }
    if (p.unit === 'second') { const d = Number(request.params.duration); return Number.isFinite(d) ? { usd: Math.round(p.usd * d * 10_000) / 10_000 } : undefined }
    return undefined
  }

  validate(request: OperationRequest, model: ModelDescriptor): { path: string; message: string }[] {
    const issues: { path: string; message: string }[] = []
    const needs = (ok: boolean, path: string, message: string): void => { if (!ok) issues.push({ path, message }) }
    if (model.capabilities.includes('inpaint')) { needs(request.inputs.source !== undefined, 'inputs.source', 'Inpainting needs a source image'); needs(request.inputs.mask !== undefined, 'inputs.mask', 'Inpainting needs a mask') }
    if (model.capabilities.includes('upscale-image')) needs(request.inputs.source !== undefined, 'inputs.source', 'Upscaling needs a source image')
    if (model.capabilities.some(c => c === 'v2v' || c === 'extend' || c === 'upscale-video')) needs(request.inputs.video !== undefined || request.inputs.source !== undefined, 'inputs.video', 'This operation needs a source video')
    return issues
  }

  private async fileUrl(ref: AssetRef, context: AdapterContext, token: string): Promise<string> {
    const file = await context.readInput(ref)
    return this.dataOrUpload(file.bytes, file.mediaType, context, token)
  }

  /** Small inputs travel as data URIs; anything over 256 kB goes through the files API (Replicate's documented rule). */
  private async dataOrUpload(bytes: Uint8Array, mediaType: string, context: AdapterContext, token: string): Promise<string> {
    if (bytes.byteLength <= DATA_URI_LIMIT) return toDataUrl(bytes, mediaType)
    const form = new FormData()
    form.append('content', new Blob([bytes as BlobPart], { type: mediaType }), `input.${mediaType.split('/')[1] ?? 'bin'}`)
    const { json } = await jsonRequest(context.fetch, `${this.base}/files`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: form, signal: context.signal, secrets: [token] })
    const url = asString(asRecord(asRecord(json).urls).get)
    if (url === undefined) throw new AdapterError('invalid', 'Replicate did not return a file URL')
    return url
  }

  async submit(request: OperationRequest, model: ModelDescriptor, context: AdapterContext): Promise<SubmitResult> {
    const token = await this.token()
    const preset = REPLICATE_PRESETS.find(p => `replicate:${p.remote}` === model.id)
    const files: Files = { refs: [] }
    let effective = request
    if (request.op === 'inpaint') {
      // Source + mask are normalised together (exact size, hard edges) and the mask is delivered in the model's polarity.
      const prepared = await prepareInpaint(request, model, context)
      if (prepared.mask === undefined) throw new AdapterError('unsupported', `${model.label} does not take a mask image`)
      files.source = await this.dataOrUpload(prepared.source.bytes, prepared.source.mediaType, context, token)
      files.mask = await this.dataOrUpload(prepared.mask, 'image/png', context, token)
      effective = { ...request, prompt: promptWith(request.prompt, prepared) }
    } else if (request.inputs.source !== undefined) {
      const isVideo = model.capabilities.some(c => c === 'v2v' || c === 'extend' || c === 'upscale-video')
      const url = await this.fileUrl(request.inputs.source, context, token)
      if (isVideo) files.video = url; else files.source = url
    }
    if (request.inputs.video !== undefined) files.video = await this.fileUrl(request.inputs.video, context, token)
    for (const ref of request.inputs.references ?? []) files.refs.push(await this.fileUrl(ref, context, token))
    if (request.inputs.firstFrame !== undefined) files.first = await this.fileUrl(request.inputs.firstFrame, context, token)
    else if (request.op === 'animate' && files.source !== undefined) files.first = files.source
    if (request.inputs.lastFrame !== undefined) files.last = await this.fileUrl(request.inputs.lastFrame, context, token)
    const input = preset === undefined ? { prompt: effective.prompt ?? '', ...(files.source === undefined ? {} : { image: files.source }), ...(typeof request.params.seed === 'number' ? { seed: request.params.seed } : {}) } : preset.map(effective, files, request.params)
    const syncWait = model.async === 'sync' ? Math.min(60, Math.max(1, this.options.waitSeconds ?? 55)) : undefined
    const headers: Record<string, string> = { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'cancel-after': this.options.cancelAfter ?? (model.async === 'job' ? '30m' : '10m'), ...(syncWait === undefined ? {} : { prefer: `wait=${String(syncWait)}` }) }
    const { json } = await jsonRequest(context.fetch, `${this.base}/models/${model.remoteId}/predictions`, { method: 'POST', headers, body: JSON.stringify({ input }), signal: context.signal, secrets: [token] })
    return this.interpret(json, model, token) ?? { kind: 'remote', remote: remoteOf(asRecord(json)), pollAfterMs: model.async === 'job' ? 5000 : 1500 }
  }

  /** Terminal prediction -> done; failed -> throws; still running -> undefined (poll). */
  private interpret(json: unknown, model: ModelDescriptor, token: string): SubmitResult | undefined {
    const r = asRecord(json); const status = asString(r.status)
    if (status === 'failed' || status === 'canceled' || status === 'aborted') throw failure(r, status)
    if (status === 'succeeded' || status === 'successful') {
      const outputs = collectOutputs(r.output, model, token)
      if (outputs.length === 0) throw new AdapterError('invalid', 'Replicate finished without output files')
      return { kind: 'done', outputs, ...(costOf(r, model) === undefined ? {} : { cost: costOf(r, model)! }) }
    }
    return undefined
  }

  async poll(remote: Readonly<Record<string, unknown>>, model: ModelDescriptor, context: AdapterContext): Promise<PollResult> {
    const token = await this.token()
    const url = asString(remote.getUrl) ?? `${this.base}/predictions/${String(remote.id)}`
    if (!url.startsWith(this.base)) throw new AdapterError('invalid', 'Refusing to poll a URL outside the Replicate API')
    const { json } = await jsonRequest(context.fetch, url, { method: 'GET', headers: { authorization: `Bearer ${token}` }, signal: context.signal, secrets: [token] })
    const r = asRecord(json); const status = asString(r.status)
    if (status === 'failed' || status === 'canceled' || status === 'aborted') return { state: 'failed', error: failure(r, status) }
    const done = this.interpret(json, model, token)
    if (done !== undefined && done.kind === 'done') return { state: 'done', outputs: done.outputs, ...(done.cost === undefined ? {} : { cost: done.cost }) }
    const logs = asString(r.logs); const percent = logs === undefined ? undefined : /(\d{1,3})%\|/.exec(logs.split('\n').reverse().join('\n'))?.[1]
    return { state: status === 'starting' ? 'queued' : 'running', ...(percent === undefined ? {} : { progress: Math.min(0.99, Number(percent) / 100) }), message: status === 'starting' ? 'Starting (cold boot can take a minute)' : 'Running', pollAfterMs: model.async === 'job' ? 5000 : 2000 }
  }

  async cancel(remote: Readonly<Record<string, unknown>>, context: AdapterContext): Promise<void> {
    const token = await this.token()
    await context.fetch(`${this.base}/predictions/${String(remote.id)}/cancel`, { method: 'POST', headers: { authorization: `Bearer ${token}` } })
  }
}

function remoteOf(r: Record<string, unknown>): Record<string, unknown> {
  const id = asString(r.id)
  if (id === undefined) throw new AdapterError('invalid', 'Replicate did not return a prediction id')
  return { id, getUrl: asString(asRecord(r.urls).get) ?? `${REPLICATE_BASE}/predictions/${id}` }
}

function failure(r: Record<string, unknown>, status: string): AdapterError {
  const message = asString(r.error) ?? `Prediction ${status}`
  if (status === 'canceled' || status === 'aborted') return new AdapterError('timeout', `${message} (the prediction hit its deadline or was canceled)`)
  if (/nsfw|safety|moderat|flagged|sensitive|blocked/i.test(message)) return new AdapterError('moderation', message)
  if (/e\d{4}|invalid|validation|required/i.test(message)) return new AdapterError('invalid', message)
  return new AdapterError('unknown', message)
}

function collectOutputs(output: unknown, model: ModelDescriptor, token: string): ProducedFile[] {
  const urls: string[] = []
  const walk = (v: unknown): void => {
    if (typeof v === 'string' && /^https:\/\//.test(v)) urls.push(v)
    else if (Array.isArray(v)) v.forEach(walk)
    else if (typeof v === 'object' && v !== null) Object.values(v).forEach(walk)
  }
  walk(output)
  const video = model.capabilities.some(c => c.endsWith('v') || c === 'v2v' || c === 'extend' || c === 'upscale-video' || c === 'first-last-frame')
  return urls.map(url => { const host = new URL(url).hostname; return { url, mediaType: video ? 'video/mp4' : 'image/png', headers: host.endsWith('replicate.delivery') || host.endsWith('replicate.com') ? { authorization: `Bearer ${token}` } : {} } })
}

/** Cost: Replicate does not return price. Estimate from preset pricing x actual duration when known. */
function costOf(r: Record<string, unknown>, model: ModelDescriptor): { usd: number; source: 'estimate' } | undefined {
  const p = model.pricing; if (p === undefined) return undefined
  if (p.unit === 'image' || p.unit === 'run') return { usd: p.usd, source: 'estimate' }
  const d = asNumber(asRecord(asRecord(r.input)).duration)
  return p.unit === 'second' && d !== undefined ? { usd: Math.round(p.usd * d * 10_000) / 10_000, source: 'estimate' } : undefined
}

void classifyHttp; void asArray
export interface ModelExample { title?: string; summary?: string; pageUrl: string; thumbUrl?: string; input?: Record<string, unknown> }

/** Author-saved example predictions for a model (GET /v1/models/{o}/{n}/examples). Shown as links/thumbnails only; never stored. */
export async function fetchModelExamples(options: { apiToken(): Promise<string | undefined>; fetch?: typeof fetch; baseUrl?: string; signal?: AbortSignal }, slug: string): Promise<{ available: boolean; examples: ModelExample[] }> {
  const token = await options.apiToken()
  if (token === undefined) return { available: false, examples: [] }
  if (!/^[a-z0-9][\w.-]*\/[\w.-]+$/i.test(slug)) return { available: true, examples: [] }
  const base = options.baseUrl ?? REPLICATE_BASE
  const { json } = await jsonRequest(options.fetch ?? fetch, `${base}/models/${slug}/examples`, { method: 'GET', headers: { authorization: `Bearer ${token}` }, ...(options.signal === undefined ? {} : { signal: options.signal }), secrets: [token] })
  const out: ModelExample[] = []
  for (const item of asArray(asRecord(json).results).slice(0, 12)) {
    const r = asRecord(item)
    const id = asString(r.id)
    const urls = asRecord(r.urls)
    const output = r.output
    const firstFile = (v: unknown): string | undefined => typeof v === 'string' && /^https:\/\/[^/]*replicate\.delivery\//.test(v) ? v : Array.isArray(v) ? v.map(firstFile).find(x => x !== undefined) : undefined
    const thumb = firstFile(output)
    const input = asRecord(r.input)
    out.push({
      pageUrl: asString(urls.web) ?? (id === undefined ? `https://replicate.com/${slug}` : `https://replicate.com/p/${id}`),
      ...(thumb === undefined ? {} : { thumbUrl: thumb }),
      ...(asString(input.prompt) === undefined ? {} : { summary: asString(input.prompt)!.slice(0, 200) }),
      ...(Object.keys(input).length === 0 ? {} : { input: Object.fromEntries(Object.entries(input).filter(([, v]) => typeof v !== 'string' || !v.startsWith('data:')).slice(0, 20)) }),
    })
  }
  return { available: true, examples: out }
}
