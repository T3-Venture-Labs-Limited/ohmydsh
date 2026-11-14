/**
 * The pre-v2 provider code (Google Gemini, OpenAI / OpenAI-compatible / xAI, subscription accounts, ComfyUI) ported onto
 * ProviderAdapter by delegating to the existing, tested request functions. All of them are image-only, synchronous providers.
 */
import type { ImageMediaType } from '@deepseek-ai/dsh-attachment'
import { AdapterError, type AdapterContext, type ModelDescriptor, type OperationRequest, type ParamSpec, type ProducedFile, type ProviderAdapter, type SubmitResult } from '../contracts.js'
import { generateOpenAICompatibleImage, editOpenAICompatibleImage } from '../../openai-compatible.js'
import { generateSubscriptionImage, type SubscriptionManager } from '../../subscription.js'
import { editComfyUIImage, generateComfyUIImage } from '../../comfyui.js'
import { SUBSCRIPTION_CAPABILITIES } from '../../capabilities.js'
import type { ComfyUIWorkflowEntry } from '../../shared.js'
import { COMFYUI_RATIO_SIZES, comfyUIRequestedSize, comfyUIWorkflowSlots, type ComfyUISize } from '../../comfyui-workflow.js'

const MAX_BYTES = 64 * 1024 * 1024
const ar = (values: readonly string[], dflt = '1:1'): ParamSpec => ({ key: 'aspect_ratio', label: 'Aspect ratio', type: 'enum', values, default: values.includes(dflt) ? dflt : values[0]! })

async function inputsOf(request: OperationRequest, context: AdapterContext): Promise<{ data: Uint8Array; mediaType: ImageMediaType }[]> {
  const refs = [...(request.inputs.source === undefined ? [] : [request.inputs.source]), ...(request.inputs.references ?? [])]
  const out: { data: Uint8Array; mediaType: ImageMediaType }[] = []
  for (const ref of refs) { const f = await context.readInput(ref); out.push({ data: f.bytes, mediaType: f.mediaType as ImageMediaType }) }
  return out
}

const done = (images: { data: Uint8Array; mediaType: string; seed?: number }[]): SubmitResult => ({ kind: 'done', outputs: images.map((i): ProducedFile => ({ bytes: i.data, mediaType: i.mediaType, ...(i.seed === undefined ? {} : { seed: i.seed }) })) })

/** Wrap a legacy call so thrown errors become classified AdapterErrors. */
async function guard<T>(call: () => Promise<T>): Promise<T> {
  try { return await call() } catch (error) {
    if (error instanceof AdapterError) throw error
    const message = error instanceof Error ? error.message : String(error)
    if (/\b(401|403)\b|unauthor|api key|not (?:signed|logged) ?in|log ?in\b|sign ?in\b/i.test(message)) throw new AdapterError('auth', message, { cause: error })
    if (/\b429\b|rate limit|quota|insufficient/i.test(message)) throw new AdapterError('quota', message, { cause: error })
    if (/safety|moderat|blocked|policy/i.test(message)) throw new AdapterError('moderation', message, { cause: error })
    throw new AdapterError('unknown', message, { cause: error })
  }
}

// ---------------------------------------------------------------- OpenAI / OpenAI-compatible / xAI (API key + base URL)
export interface CompatEndpoint { id: string; label: string; baseURL: string; apiKey(): Promise<string | undefined>; models: readonly string[]; provider: 'openai' | 'openai-compat' | 'xai'; strict?: boolean }

export class CompatAdapter implements ProviderAdapter {
  constructor(readonly id: 'openai' | 'openai-compat' | 'xai', private readonly endpoints: () => readonly CompatEndpoint[]) {}
  async isConfigured(): Promise<boolean> { for (const e of this.endpoints()) if ((await e.apiKey()) !== undefined && e.baseURL.length > 0) return true; return false }
  async listModels(): Promise<readonly ModelDescriptor[]> {
    return this.endpoints().flatMap(e => e.models.map((remote): ModelDescriptor => ({
      id: `${this.id}:${e.id}/${remote}`, provider: this.id, remoteId: remote, label: `${e.label}: ${remote}`, capabilities: ['t2i', 'i2i'], inputs: { images: { max: 5, roles: ['ref', 'source'] } },
      params: [ar(['1:1', '3:2', '2:3', '16:9', '9:16']), { key: 'size', label: 'Size (WxH)', type: 'text' }, { key: 'quality', label: 'Quality', type: 'enum', values: ['auto', 'low', 'medium', 'high'], default: 'auto' }], async: 'sync', curated: false,
    })))
  }
  async submit(request: OperationRequest, model: ModelDescriptor, context: AdapterContext): Promise<SubmitResult> {
    const slash = model.id.indexOf('/'); const endpointId = model.id.slice(model.id.indexOf(':') + 1, slash)
    const endpoint = this.endpoints().find(e => e.id === endpointId)
    const apiKey = endpoint === undefined ? undefined : await endpoint.apiKey()
    if (endpoint === undefined || apiKey === undefined) throw new AdapterError('auth', `${model.label} has no API key`)
    const sources = await inputsOf(request, context)
    const common = { strictImageDownloads: endpoint.strict === true, apiKey, baseURL: endpoint.baseURL, model: model.remoteId, prompt: request.prompt ?? '', maxBytes: MAX_BYTES, signal: context.signal,
      ...(typeof request.params.size === 'string' && request.params.size.length > 0 ? { size: request.params.size } : {}),
      ...(typeof request.params.quality === 'string' && request.params.quality !== 'auto' ? { quality: request.params.quality } : {}) }
    const image = await guard(() => sources.length > 0 ? editOpenAICompatibleImage({ ...common, sourceImages: sources }) : generateOpenAICompatibleImage({ ...common, provider: this.id }))
    if (image.mediaType === 'image/svg+xml') throw new AdapterError('invalid', 'SVG output is not supported by the studio gallery')
    return done([image])
  }
}

// ---------------------------------------------------------------- subscriptions (Grok, Google)
export class SubscriptionAdapter implements ProviderAdapter {
  constructor(readonly id: 'grok-sub' | 'google-sub', private readonly manager: () => SubscriptionManager | undefined, private readonly loggedIn: () => Promise<boolean>) {}
  async isConfigured(): Promise<boolean> { return this.manager() !== undefined && (await this.loggedIn().catch(() => false)) }
  async listModels(): Promise<readonly ModelDescriptor[]> {
    const cap = SUBSCRIPTION_CAPABILITIES[this.id]
    const remote = this.id === 'grok-sub' ? 'grok-imagine-image-2.0' : 'gemini-3.1-flash-image'
    return [{ id: `${this.id}:${remote}`, provider: this.id, remoteId: remote, label: this.id === 'grok-sub' ? 'Grok Imagine (subscription)' : 'Gemini Flash Image (subscription)', capabilities: ['t2i', 'i2i'], inputs: { images: { max: 5, roles: ['ref', 'source'] } },
      params: [ar(cap.ratioOptions.map(o => o.value), 'auto'), { key: 'resolution', label: 'Resolution', type: 'enum', values: cap.qualityOptions.map(o => o.value), default: cap.defaultQuality }],
      async: 'sync', curated: true, tier: 'value', pricing: { unit: 'run', usd: 0, note: 'Included in your subscription' } }]
  }
  async submit(request: OperationRequest, _model: ModelDescriptor, context: AdapterContext): Promise<SubmitResult> {
    const manager = this.manager(); if (manager === undefined) throw new AdapterError('unavailable', 'Subscription manager is not ready')
    const sources = await inputsOf(request, context)
    const ratio = String(request.params.aspect_ratio ?? 'auto'); const resolution = request.params.resolution === undefined ? undefined : String(request.params.resolution)
    const image = await guard(() => generateSubscriptionImage({ manager, provider: this.id, prompt: request.prompt ?? '', size: ratio, ...(resolution === undefined ? {} : { quality: resolution }), sourceImages: sources, maxBytes: MAX_BYTES, signal: context.signal }))
    return done([image])
  }
}

// ---------------------------------------------------------------- ComfyUI (imported API workflows)
export interface ComfyOptions { baseURL(): string; timeoutMs(): number; workflows(): readonly ComfyUIWorkflowEntry[] }

export class ComfyUIAdapter implements ProviderAdapter {
  readonly id = 'comfyui' as const
  constructor(private readonly o: ComfyOptions) {}
  async isConfigured(): Promise<boolean> { return this.o.workflows().length > 0 }
  async listModels(): Promise<readonly ModelDescriptor[]> {
    return this.o.workflows().map((w): ModelDescriptor => {
      const slots = comfyUIWorkflowSlots(w.json)
      return { id: `comfyui:${w.name}`, provider: 'comfyui', remoteId: w.name, label: `ComfyUI: ${w.name}`, capabilities: slots.images > 0 ? ['t2i', 'i2i'] : ['t2i'], inputs: slots.images > 0 ? { images: { max: slots.images, roles: ['ref', 'source'] } } : {},
        params: slots.size ? [{ key: 'aspect_ratio', label: 'Aspect ratio', type: 'enum', values: Object.keys(COMFYUI_RATIO_SIZES), default: '1:1' }, { key: 'width', label: 'Width (overrides ratio)', type: 'integer', min: 64, max: 8192 }, { key: 'height', label: 'Height (overrides ratio)', type: 'integer', min: 64, max: 8192 }] : [], async: 'sync', curated: false, pricing: { unit: 'run', usd: 0, note: 'Runs on your machine' } }
    })
  }
  async submit(request: OperationRequest, model: ModelDescriptor, context: AdapterContext): Promise<SubmitResult> {
    const workflow = this.o.workflows().find(w => w.name === model.remoteId); if (workflow === undefined) throw new AdapterError('invalid', `Workflow "${model.remoteId}" is no longer configured`)
    // An exact width x height wins over the ratio bucket; a frame is only sent when the workflow has {{width}}/{{height}} placeholders.
    const exact = typeof request.params.width === 'number' && typeof request.params.height === 'number' ? `${String(request.params.width)}x${String(request.params.height)}` : undefined
    let size: ComfyUISize | undefined
    try { size = comfyUIWorkflowSlots(workflow.json).size ? comfyUIRequestedSize(exact, typeof request.params.aspect_ratio === 'string' ? request.params.aspect_ratio : undefined) : undefined } catch (error) { throw new AdapterError('invalid', error instanceof Error ? error.message : String(error)) }
    const prompt = `${workflow.presetPrompt ?? ''} ${request.prompt ?? ''}`.trim()
    const sources = await inputsOf(request, context)
    const base = { baseURL: this.o.baseURL(), timeoutMs: this.o.timeoutMs(), signal: context.signal, workflowJson: workflow.json, prompt, maxBytes: MAX_BYTES, ...(size === undefined ? {} : { size }) }
    const image = await guard(() => sources.length > 0 ? editComfyUIImage({ ...base, sourceImages: sources }) : generateComfyUIImage(base))
    return done([image])
  }
}
