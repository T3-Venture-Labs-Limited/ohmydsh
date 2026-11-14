/**
 * Google Gemini API (key) adapter.
 *  - Images: Nano Banana family through `models/{id}:generateContent` (text + up to 14 reference images, `imageConfig`), synchronous.
 *    Gemini has no mask input: inpaint is semantic (describe the region in words), so we do not advertise `inpaint`.
 *  - Video: `gemini-omni-1.2-flash` through `POST /v1beta/interactions` (t2v, i2v, first+last frame, reference images, edit and extend).
 *    The call is synchronous (the finished video is inline or, for large outputs, a Files-API uri we poll until ACTIVE).
 *  Facts verified against the Omni and image-generation docs on 2026-11-14 (aistudio.google.com/docs/omni.md, ai.google.dev/gemini-api/docs/image-generation).
 *  Not verified live: no GEMINI_API_KEY is available in the development environment, so behaviour is covered by fixtures only.
 */
import { AdapterError, type AdapterContext, type ModelDescriptor, type OperationRequest, type ParamSpec, type PollResult, type ProducedFile, type ProviderAdapter, type SubmitResult } from '../contracts.js'
import { asArray, asRecord, asString, jsonRequest } from './http.js'

export const GOOGLE_BASE = 'https://generativelanguage.googleapis.com'
export const OMNI_MODEL = 'gemini-omni-1.2-flash'
const INLINE_LIMIT = 18 * 1024 * 1024        // generateContent / interactions request bodies stay under the 20 MB inline cap

const ASPECTS = ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9'] as const
const aspects = (extra: readonly string[] = []): ParamSpec => ({ key: 'aspect_ratio', label: 'Aspect ratio', type: 'enum', values: [...ASPECTS, ...extra], default: '1:1' })

interface ImagePreset { remote: string; label: string; tier: 'quality' | 'value' | 'draft'; sizes: readonly string[]; refs: number; pricing: { usd: number; note: string }; extraAspects?: readonly string[] }
export const GOOGLE_IMAGE_PRESETS: readonly ImagePreset[] = [
  { remote: 'gemini-nano-banana-2.1', label: 'Nano Banana 2.1', tier: 'value', sizes: ['1K', '2K', '4K'], refs: 14, pricing: { usd: 0.0336, note: '1K; 2K ≈ $0.05, 4K ≈ $0.11' }, extraAspects: ['1:4', '4:1', '1:8', '8:1'] },
  { remote: 'gemini-3-pro-image', label: 'Nano Banana Pro', tier: 'quality', sizes: ['1K', '2K', '4K'], refs: 14, pricing: { usd: 0.13, note: '1K; 4K ≈ $0.24' } },
  { remote: 'gemini-3.1-flash-lite-image', label: 'Nano Banana 2 Lite', tier: 'draft', sizes: ['1K'], refs: 4, pricing: { usd: 0.0336, note: '1K' } },
]

const OMNI: ModelDescriptor = {
  id: `google:${OMNI_MODEL}`, provider: 'google', remoteId: OMNI_MODEL, label: 'Gemini Omni 1.2 Flash', tier: 'value', verifiedAt: '2026-11-14', async: 'job', curated: true,
  capabilities: ['t2v', 'i2v', 'first-last-frame', 'v2v', 'extend'],
  inputs: { images: { max: 6, roles: ['first', 'last', 'ref'] }, video: { max: 1 } },
  limits: { maxDurationS: 15, maxInputMB: 18 },
  params: [
    { key: 'duration', label: 'Duration (s)', type: 'integer', min: 3, max: 15, default: 8 },
    { key: 'resolution', label: 'Resolution', type: 'enum', values: ['360p', '720p', '1080p', '4k'], default: '720p' },
    { key: 'aspect_ratio', label: 'Aspect ratio', type: 'enum', values: ['16:9', '9:16'], default: '16:9' },
  ],
  // $/s by tier: 360p $0.023, 720p $0.07, 1080p $0.104, 4K $0.209 (1080p/4K are upscaled from 720p).
  pricing: { unit: 'second', usd: 0.07, byParam: { key: 'resolution', usd: { '360p': 0.023, '720p': 0.07, '1080p': 0.104, '4k': 0.209 } }, note: 'Paid tier only; 1080p/4K are upscaled' },
}

export interface GoogleOptions {
  apiKey(): Promise<string | undefined>
  fetch?: typeof fetch
  baseUrl?: string
  /** Extra Nano Banana model ids from settings (the legacy single configured model). */
  extraImageModels?(): readonly string[]
}

export class GoogleDirectAdapter implements ProviderAdapter {
  readonly id = 'google' as const
  private readonly base: string
  constructor(private readonly options: GoogleOptions) { this.base = options.baseUrl ?? GOOGLE_BASE }

  async isConfigured(): Promise<boolean> { return (await this.options.apiKey()) !== undefined }
  private async key(): Promise<string> {
    const k = await this.options.apiKey()
    if (k === undefined) throw new AdapterError('auth', 'Google has no API key. Add GEMINI_API_KEY in Settings > Plugins > Studio.')
    return k
  }

  async listModels(): Promise<readonly ModelDescriptor[]> {
    const images = GOOGLE_IMAGE_PRESETS.map((p): ModelDescriptor => ({
      id: `google:${p.remote}`, provider: 'google', remoteId: p.remote, label: p.label, tier: p.tier, verifiedAt: '2026-11-14', async: 'sync', curated: true,
      capabilities: ['t2i', 'i2i'], inputs: { images: { max: p.refs, roles: ['ref', 'source'] } },
      params: [aspects(p.extraAspects), { key: 'image_size', label: 'Resolution', type: 'enum', values: p.sizes, default: p.sizes[0]! }],
      pricing: { unit: 'image', usd: p.pricing.usd, note: p.pricing.note },
    }))
    const known = new Set(GOOGLE_IMAGE_PRESETS.map(p => p.remote))
    const extra = (this.options.extraImageModels?.() ?? []).filter(m => /^[\w.-]+$/.test(m) && !known.has(m) && m !== OMNI_MODEL).map((remote): ModelDescriptor => ({
      id: `google:${remote}`, provider: 'google', remoteId: remote, label: `Gemini ${remote.replace(/^gemini-/, '')}`, async: 'sync', curated: false,
      capabilities: ['t2i', 'i2i'], inputs: { images: { max: 14, roles: ['ref', 'source'] } }, params: [aspects(), { key: 'image_size', label: 'Resolution', type: 'enum', values: ['1K', '2K', '4K'], default: '1K' }],
    }))
    return [...images, ...extra, OMNI]
  }

  validate(request: OperationRequest, model: ModelDescriptor): { path: string; message: string }[] {
    const issues: { path: string; message: string }[] = []
    const add = (path: string, message: string): void => { issues.push({ path, message }) }
    if (model.remoteId !== OMNI_MODEL) return issues
    const refs = request.inputs.references?.length ?? 0
    const frames = (request.inputs.firstFrame === undefined ? 0 : 1) + (request.inputs.lastFrame === undefined ? 0 : 1) + (request.op === 'animate' && request.inputs.source !== undefined ? 1 : 0)
    const duration = typeof request.params.duration === 'number' ? request.params.duration : 8
    if (refs + frames > 6) add('inputs', 'Gemini Omni accepts at most 6 reference images in total')
    if (request.inputs.firstFrame !== undefined && request.inputs.lastFrame !== undefined && duration > 10) add('params.duration', 'First and last frame videos support 3 to 10 seconds')
    if (request.op === 'restyle' || request.op === 'edit') { if (request.inputs.video === undefined && request.inputs.source === undefined) add('inputs.video', 'Editing needs a source video') ; if ((request.prompt ?? '').trim() === '') add('prompt', 'Describe the change to make') }
    if (request.op === 'extend' && request.inputs.video === undefined && request.inputs.source === undefined) add('inputs.video', 'Extending needs a source video')
    if (request.op === 'extend' && typeof request.params.duration === 'number' && request.params.duration > 10) add('params.duration', 'Extension adds 3 to 10 seconds per turn')
    return issues
  }

  estimate(request: OperationRequest, model: ModelDescriptor): { usd?: number } | undefined {
    const p = model.pricing; if (p === undefined) return undefined
    if (p.unit === 'image') return { usd: p.usd }
    if (p.unit === 'second') {
      const duration = typeof request.params.duration === 'number' ? request.params.duration : request.op === 'extend' ? 10 : 8
      const res = typeof request.params.resolution === 'string' ? request.params.resolution : '720p'
      return { usd: Math.round((p.byParam?.usd[res] ?? p.usd) * duration * 10_000) / 10_000 }
    }
    return undefined
  }

  async submit(request: OperationRequest, model: ModelDescriptor, context: AdapterContext): Promise<SubmitResult> {
    const key = await this.key()
    return model.remoteId === OMNI_MODEL ? this.submitVideo(request, model, context, key) : this.submitImage(request, model, context, key)
  }

  // ------------------------------------------------------------------------------------------------ images (generateContent)
  private async submitImage(request: OperationRequest, model: ModelDescriptor, context: AdapterContext, key: string): Promise<SubmitResult> {
    const refs = [...(request.inputs.source === undefined ? [] : [request.inputs.source]), ...(request.inputs.references ?? [])]
    const parts: Record<string, unknown>[] = []
    let total = 0
    for (const [i, ref] of refs.entries()) {
      const file = await context.readInput(ref)
      total += file.bytes.byteLength
      if (total > INLINE_LIMIT) throw new AdapterError('invalid', 'The reference images are larger than 18 MB in total; use fewer or smaller images')
      // Labelled parts keep multi-image prompts unambiguous ("use the style of image 2").
      if (refs.length > 1) parts.push({ text: `Image ${String(i + 1)}:` })
      parts.push({ inlineData: { mimeType: file.mediaType, data: Buffer.from(file.bytes).toString('base64') } })
    }
    parts.push({ text: request.prompt ?? '' })
    const p = request.params
    const body = {
      contents: [{ role: 'user', parts }],
      generationConfig: { responseModalities: ['TEXT', 'IMAGE'], imageConfig: { ...(typeof p.aspect_ratio === 'string' ? { aspectRatio: p.aspect_ratio } : {}), ...(typeof p.image_size === 'string' ? { imageSize: p.image_size } : {}) } },
    }
    const { json } = await jsonRequest(context.fetch, `${this.base}/v1beta/models/${model.remoteId}:generateContent`, { method: 'POST', headers: this.headers(key), body: JSON.stringify(body), signal: context.signal, secrets: [key] })
    const root = asRecord(json)
    const feedback = asRecord(root.promptFeedback)
    if (asString(feedback.blockReason) !== undefined) throw new AdapterError('moderation', `Google blocked the prompt (${String(feedback.blockReason)})`)
    const outputs: ProducedFile[] = []
    let finish: string | undefined
    for (const candidate of asArray(root.candidates)) {
      const c = asRecord(candidate); finish = finish ?? asString(c.finishReason)
      for (const part of asArray(asRecord(c.content).parts)) {
        const inline = asRecord(asRecord(part).inlineData ?? asRecord(part).inline_data)
        const data = asString(inline.data)
        if (data !== undefined) outputs.push({ bytes: new Uint8Array(Buffer.from(data, 'base64')), mediaType: asString(inline.mimeType ?? inline.mime_type) ?? 'image/png' })
      }
    }
    if (outputs.length === 0) {
      if (finish !== undefined && /SAFETY|PROHIBITED|BLOCK|IMAGE_OTHER|RECITATION/i.test(finish)) throw new AdapterError('moderation', `Google declined to produce an image (${finish})`)
      throw new AdapterError('invalid', `Google returned no image${finish === undefined ? '' : ` (finish reason ${finish})`}. Try rephrasing the prompt.`)
    }
    const est = this.estimate(request, model)?.usd
    return { kind: 'done', outputs, ...(est === undefined ? {} : { cost: { usd: est, source: 'estimate' as const } }) }
  }

  // ------------------------------------------------------------------------------------------------ video (Interactions API)
  private async submitVideo(request: OperationRequest, model: ModelDescriptor, context: AdapterContext, key: string): Promise<SubmitResult> {
    const content: Record<string, unknown>[] = []
    let total = 0
    const media = async (ref: { assetId: string }, type: 'image' | 'video'): Promise<Record<string, unknown>> => {
      const file = await context.readInput(ref)
      total += file.bytes.byteLength
      if (total > INLINE_LIMIT) throw new AdapterError('invalid', 'The inputs are larger than 18 MB in total; use a shorter or smaller clip')
      return { type, data: Buffer.from(file.bytes).toString('base64'), mime_type: file.mediaType }
    }
    const op = request.op
    const sourceVideo = request.inputs.video ?? (['restyle', 'edit', 'extend'].includes(op) ? request.inputs.source : undefined)
    const previous = sourceVideo === undefined ? undefined : context.recall?.(sourceVideo, 'interaction')
    const body: Record<string, unknown> = { model: model.remoteId }
    if (sourceVideo !== undefined) {
      if (previous !== undefined) body.previous_interaction_id = previous              // a clip Gemini made itself: no re-upload, works in every region
      else content.push(await media(sourceVideo, 'video'))                             // uploaded clip (not available in EEA / CH / UK)
    }
    if (op === 'generate' || op === 'animate') {
      const first = request.inputs.firstFrame ?? (op === 'animate' ? request.inputs.source : undefined)
      if (first !== undefined) content.push(await media(first, 'image'))
      if (request.inputs.lastFrame !== undefined) content.push(await media(request.inputs.lastFrame, 'image'))
    }
    for (const ref of request.inputs.references ?? []) content.push(await media(ref, 'image'))
    const prompt = (op === 'extend' && (request.prompt ?? '').trim() === '' ? 'Continue the scene.' : request.prompt ?? '').trim()
    if (prompt !== '') content.push({ type: 'text', text: prompt })
    if (content.length === 0 && previous === undefined) throw new AdapterError('invalid', 'Describe the video you want')
    body.input = content.length === 1 && content[0]!.type === 'text' ? content[0]!.text : content
    const p = request.params
    const duration = typeof p.duration === 'number' ? p.duration : undefined
    const format: Record<string, unknown> = { type: 'video', delivery: 'uri' }
    if (typeof p.aspect_ratio === 'string') format.aspect_ratio = p.aspect_ratio
    if (typeof p.resolution === 'string') format.resolution = p.resolution
    // Extension length is chosen by the model unless asked; for new/edit clips the response_format duration is documented as "3s".."15s".
    if (duration !== undefined && op !== 'extend') format.duration = `${String(duration)}s`
    body.response_format = format
    const { json } = await jsonRequest(context.fetch, `${this.base}/v1beta/interactions`, { method: 'POST', headers: this.headers(key), body: JSON.stringify(body), signal: context.signal, secrets: [key] })
    return this.finishVideo(json, request, model, context, key)
  }

  private async finishVideo(json: unknown, request: OperationRequest, model: ModelDescriptor, context: AdapterContext, key: string): Promise<SubmitResult> {
    const root = asRecord(json)
    const status = asString(root.status)
    if (status === 'failed' || status === 'cancelled' || status === 'canceled') throw new AdapterError('unknown', `Gemini Omni ${status}${asString(asRecord(root.error).message) === undefined ? '' : `: ${String(asRecord(root.error).message)}`}`)
    let inline: { data?: string; uri?: string; mime?: string } | undefined
    for (const step of asArray(root.steps)) {
      const s = asRecord(step); if (s.type !== 'model_output') continue
      for (const item of asArray(s.content)) {
        const c = asRecord(item); if (c.type !== 'video') continue
        inline = { ...(asString(c.data) === undefined ? {} : { data: asString(c.data)! }), ...(asString(c.uri) === undefined ? {} : { uri: asString(c.uri)! }), ...(asString(c.mime_type) === undefined ? {} : { mime: asString(c.mime_type)! }) }
      }
    }
    // Text-only answers happen when the model refuses (safety) or misunderstands the request: surface its words.
    if (inline === undefined) {
      const text = asArray(root.steps).flatMap(st => asArray(asRecord(st).content)).map(c => asRecord(c)).filter(c => c.type === 'text').map(c => asString(c.text) ?? '').join(' ').trim()
      throw new AdapterError(/cannot|unable|policy|safety|sensitive/i.test(text) ? 'moderation' : 'invalid', `Gemini Omni returned no video${text === '' ? '' : `: ${text.slice(0, 240)}`}`)
    }
    const interaction = asString(root.id)
    const notes = interaction === undefined ? {} : { notes: { interaction } }
    const est = this.estimate(request, model)?.usd
    const cost = est === undefined ? {} : { cost: { usd: est, source: 'estimate' as const } }
    if (inline.data !== undefined) return { kind: 'done', outputs: [{ bytes: new Uint8Array(Buffer.from(inline.data, 'base64')), mediaType: inline.mime ?? 'video/mp4', ...notes }], ...cost }
    // delivery:"uri": the video is a Files-API object that is ACTIVE when processing has finished.
    const fileName = /\/files\/([^/:?]+)/.exec(inline.uri ?? '')?.[1]
    if (fileName === undefined) throw new AdapterError('invalid', 'Gemini returned a video without data or a file reference')
    return { kind: 'remote', remote: { file: fileName, ...(interaction === undefined ? {} : { interaction }) }, pollAfterMs: 5000 }
  }

  async poll(remote: Readonly<Record<string, unknown>>, _model: ModelDescriptor, context: AdapterContext): Promise<PollResult> {
    const key = await this.key()
    const file = String(remote.file ?? '')
    if (!/^[\w-]+$/.test(file)) throw new AdapterError('invalid', 'Invalid Gemini file reference')
    const { json } = await jsonRequest(context.fetch, `${this.base}/v1beta/files/${file}`, { method: 'GET', headers: this.headers(key), signal: context.signal, secrets: [key] })
    const state = asString(asRecord(json).state)
    if (state === 'FAILED') return { state: 'failed', error: new AdapterError('unknown', `Gemini could not process the video: ${asString(asRecord(asRecord(json).error).message) ?? 'unknown error'}`) }
    if (state !== 'ACTIVE') return { state: 'running', message: 'Rendering video', pollAfterMs: 5000 }
    const interaction = typeof remote.interaction === 'string' ? remote.interaction : undefined
    return { state: 'done', outputs: [{ url: `${this.base}/v1beta/files/${file}:download?alt=media`, headers: { 'x-goog-api-key': key }, mediaType: asString(asRecord(json).mimeType) ?? 'video/mp4', ...(interaction === undefined ? {} : { notes: { interaction } }) }] }
  }

  private headers(key: string): Record<string, string> { return { 'x-goog-api-key': key, 'content-type': 'application/json' } }
}
