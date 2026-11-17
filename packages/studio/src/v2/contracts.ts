/**
 * Studio v2 contracts: the capability-driven model shared by the host and (later) the client.
 * No runtime dependencies here: types, small constants and pure helpers only.
 */

export type MediaKind = 'image' | 'video'

/** What a model can do. UI controls, tool enums and validation all derive from this data. */
export type Capability =
  | 't2i' | 'i2i' | 'inpaint' | 'upscale-image'
  | 't2v' | 'i2v' | 'v2v' | 'extend' | 'upscale-video' | 'first-last-frame'

/** Operation a request performs. */
export type Operation = 'generate' | 'edit' | 'inpaint' | 'upscale' | 'animate' | 'restyle' | 'extend'

export type ProviderId =
  | 'openrouter' | 'replicate' | 'google' | 'grok-sub' | 'google-sub' | 'comfyui' | 'openai' | 'openai-compat' | 'xai'

/** How an inpaint model consumes the mask. `white-edit`: white pixels are repainted; `black-edit`: black pixels are. */
export type MaskPolarity = 'white-edit' | 'black-edit' | 'alpha'
export type InpaintMode = 'mask' | 'markup' | 'overlay-prompt'

export type ParamValue = string | number | boolean
export type ParamSpec =
  | { key: string; label: string; type: 'enum'; values: readonly string[]; default?: string; when?: ParamWhen }
  | { key: string; label: string; type: 'number'; min: number; max: number; step?: number; default?: number; when?: ParamWhen }
  | { key: string; label: string; type: 'integer'; min: number; max: number; default?: number; when?: ParamWhen }
  | { key: string; label: string; type: 'boolean'; default?: boolean; when?: ParamWhen }
  | { key: string; label: string; type: 'text'; default?: string; when?: ParamWhen }

/** A parameter is shown only when another parameter has one of these values. */
export interface ParamWhen { key: string; in: readonly ParamValue[] }

export interface InputLimits {
  images?: { max: number; roles: readonly ImageRole[] }
  video?: { max: number }
  audio?: boolean
}
export type ImageRole = 'ref' | 'first' | 'last' | 'source' | 'mask'

/** Price data used for the up-front estimate. Estimates only: no caps anywhere. */
export type Pricing =
  | { unit: 'image'; usd: number; note?: string }
  | { unit: 'second'; usd: number; note?: string; byParam?: { key: string; usd: Readonly<Record<string, number>> } }
  | { unit: 'megapixel'; usd: number; note?: string }
  | { unit: 'megapixel-second'; usd: number; note?: string }
  | { unit: 'run'; usd: number; note?: string }

export interface ModelDescriptor {
  /** Globally unique: `<provider>:<remoteId>`. */
  id: string
  provider: ProviderId
  remoteId: string
  label: string
  capabilities: readonly Capability[]
  inputs: InputLimits
  params: readonly ParamSpec[]
  inpaintMode?: InpaintMode
  maskPolarity?: MaskPolarity
  limits?: { maxDurationS?: number; maxPixels?: number; maxInputMB?: number }
  pricing?: Pricing
  /** `sync`: one call returns bytes. `job`: the provider returns a remote job id that survives restarts. */
  async: 'sync' | 'job'
  /** True for curated presets, false for models discovered from a provider catalog. */
  curated: boolean
  /** Tier hint for pickers. */
  tier?: 'quality' | 'value' | 'draft'
  /** ISO date the preset was last checked against the provider. */
  verifiedAt?: string
  deprecated?: boolean
}

export interface AssetRef {
  /** Studio asset id (ULID-like). */
  assetId: string
}

export interface OperationInputs {
  source?: AssetRef
  references?: readonly AssetRef[]
  mask?: AssetRef
  firstFrame?: AssetRef
  lastFrame?: AssetRef
  video?: AssetRef
}

/** What the UI, the tools and the agent produce; validated against the model's ParamSpec list. */
export interface OperationRequest {
  op: Operation
  modelId: string
  prompt?: string
  negativePrompt?: string
  inputs: OperationInputs
  params: Readonly<Record<string, ParamValue>>
  tags?: readonly string[]
  /** Origin of the request, recorded on the job. */
  origin?: 'agent' | 'ui' | 'import'
  sessionId?: string
}

export interface ValidationIssue { path: string; message: string }

/** A file the adapter produced. The runner downloads/hashes/stores it; adapters never touch storage. */
export interface ProducedFile {
  bytes?: Uint8Array
  url?: string
  /** Extra headers for `url` downloads (OpenRouter content needs the bearer token). */
  headers?: Readonly<Record<string, string>>
  mediaType: string
  seed?: number
  meta?: Readonly<Record<string, unknown>>
  /** Small provider facts to remember for the stored asset (e.g. a Gemini interaction id enabling later edits). Strings only, never secrets. */
  notes?: Readonly<Record<string, string>>
}

export interface ActualCost { usd: number; source: 'provider' | 'estimate' }

export type SubmitResult =
  | { kind: 'done'; outputs: readonly ProducedFile[]; cost?: ActualCost }
  | { kind: 'remote'; remote: Readonly<Record<string, unknown>>; pollAfterMs: number }

export type PollResult =
  | { state: 'queued' | 'running'; progress?: number; message?: string; pollAfterMs?: number }
  | { state: 'done'; outputs: readonly ProducedFile[]; cost?: ActualCost }
  | { state: 'failed'; error: AdapterError }

export type AdapterErrorKind = 'auth' | 'quota' | 'moderation' | 'invalid' | 'unavailable' | 'timeout' | 'unsupported' | 'unknown'

/** Error taxonomy the runner understands: it decides retry vs needs_attention vs failed. */
export class AdapterError extends Error {
  readonly kind: AdapterErrorKind
  readonly retryable: boolean
  readonly status?: number
  constructor(kind: AdapterErrorKind, message: string, options: { retryable?: boolean; status?: number; cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'AdapterError'
    this.kind = kind
    this.retryable = options.retryable ?? (kind === 'unavailable' || kind === 'timeout')
    if (options.status !== undefined) this.status = options.status
  }
}

export type JobState = 'queued' | 'submitting' | 'running' | 'finalizing' | 'succeeded' | 'failed' | 'canceled' | 'needs_attention'
export const ACTIVE_JOB_STATES: readonly JobState[] = ['queued', 'submitting', 'running', 'finalizing']
export const TERMINAL_JOB_STATES: readonly JobState[] = ['succeeded', 'failed', 'canceled']

export interface JobRecord {
  id: string
  createdAt: number
  startedAt?: number
  finishedAt?: number
  updatedAt: number
  state: JobState
  op: Operation
  modelId: string
  provider: ProviderId
  request: OperationRequest
  remote?: Readonly<Record<string, unknown>>
  progress?: number
  message?: string
  error?: { kind: AdapterErrorKind; message: string }
  attempt: number
  assetIds: readonly string[]
  origin: 'agent' | 'ui' | 'import'
  sessionId?: string
  agentJobId?: string
  estimateUsd?: number
  costUsd?: number
  costSource?: 'provider' | 'estimate'
}

export interface AssetRecord {
  id: string
  sha256: string
  kind: MediaKind
  ext: string
  mime: string
  bytes: number
  width?: number
  height?: number
  durationMs?: number
  fps?: number
  hasAudio?: boolean
  codec?: string
  posterSha?: string
  createdAt: number
  source: 'generated' | 'import' | 'render' | 'derived' | 'agent'
  jobId?: string
  op?: Operation
  provider?: ProviderId
  modelId?: string
  prompt?: string
  negativePrompt?: string
  params?: Readonly<Record<string, unknown>>
  seed?: number
  costUsd?: number
  title?: string
  favorite: boolean
  rating?: number
  deletedAt?: number
  sessionId?: string
  workspacePath?: string
  notes?: string
  /** Set on assets the gallery collected from an agent tool result (source `agent`): which tool made it and the provider/model the agent asked for. */
  origin?: AssetOrigin
  tags: readonly string[]
}

export interface AssetOrigin { tool: string; provider?: string; model?: string }

export type EdgeRole = 'source' | 'reference' | 'mask' | 'first_frame' | 'last_frame' | 'video' | 'upscale-of' | 'extend-of'

export interface AssetEdge { childId: string; parentId: string; role: EdgeRole; ord: number }

/** The adapter face. Credentials are resolved inside adapters through the injected `credentials()` function. */
export interface AdapterContext {
  signal: AbortSignal
  /** Read an input asset as bytes (images) or a local file path (videos). */
  readInput(ref: AssetRef): Promise<{ bytes: Uint8Array; mediaType: string; width?: number; height?: number }>
  /** A currently valid public HTTPS URL for an asset the provider itself hosted (short-lived), when one is known. */
  publicUrl?(ref: AssetRef): string | undefined
  /** A provider note remembered for an asset (see ProducedFile.notes). */
  recall?(ref: AssetRef, key: string): string | undefined
  fetch: typeof fetch
}

export interface ProviderAdapter {
  readonly id: ProviderId
  isConfigured(): Promise<boolean>
  listModels(options?: { refresh?: boolean }): Promise<readonly ModelDescriptor[]>
  validate?(request: OperationRequest, model: ModelDescriptor): readonly ValidationIssue[]
  estimate?(request: OperationRequest, model: ModelDescriptor): { usd?: number; seconds?: number } | undefined
  submit(request: OperationRequest, model: ModelDescriptor, context: AdapterContext): Promise<SubmitResult>
  poll?(remote: Readonly<Record<string, unknown>>, model: ModelDescriptor, context: AdapterContext): Promise<PollResult>
  cancel?(remote: Readonly<Record<string, unknown>>, context: AdapterContext): Promise<void>
}

/** Capabilities a request's operation needs from a model. */
export function capabilitiesFor(request: Pick<OperationRequest, 'op' | 'inputs'>, kind: MediaKind): readonly Capability[] {
  const { op, inputs } = request
  if (kind === 'video') {
    switch (op) {
      case 'generate': return inputs.firstFrame !== undefined && inputs.lastFrame !== undefined ? ['first-last-frame']
        : inputs.firstFrame !== undefined ? ['i2v'] : ['t2v']
      case 'animate': return inputs.lastFrame !== undefined ? ['first-last-frame'] : ['i2v']
      case 'restyle': case 'edit': return ['v2v']
      case 'extend': return ['extend']
      case 'upscale': return ['upscale-video']
      default: return ['t2v']
    }
  }
  switch (op) {
    case 'generate': return (inputs.references?.length ?? 0) > 0 ? ['i2i'] : ['t2i']
    case 'edit': case 'restyle': return ['i2i']
    case 'inpaint': return ['inpaint']
    case 'upscale': return ['upscale-image']
    default: return ['t2i']
  }
}

/** True when the model can serve every needed capability. */
export function supports(model: Pick<ModelDescriptor, 'capabilities'>, needed: readonly Capability[]): boolean {
  return needed.every(capability => model.capabilities.includes(capability))
}

/** Output media kind of a capability set. */
export function mediaKindOf(capabilities: readonly Capability[]): MediaKind {
  return capabilities.some(c => c.endsWith('v') || c === 'v2v' || c === 'extend' || c === 'upscale-video' || c === 'first-last-frame') ? 'video' : 'image'
}

/** Apply defaults and validate request params against the model's ParamSpec list. */
export function validateParams(model: Pick<ModelDescriptor, 'params'>, params: Readonly<Record<string, ParamValue>>): { value: Record<string, ParamValue>; issues: ValidationIssue[] } {
  const value: Record<string, ParamValue> = {}
  const issues: ValidationIssue[] = []
  const known = new Set(model.params.map(spec => spec.key))
  for (const key of Object.keys(params)) if (!known.has(key)) issues.push({ path: `params.${key}`, message: `Unknown parameter "${key}" for this model` })
  for (const spec of model.params) {
    if (spec.when !== undefined) {
      const gate = params[spec.when.key] ?? model.params.find(p => p.key === spec.when!.key && 'default' in p)?.['default' as never]
      if (gate === undefined || !spec.when.in.includes(gate as ParamValue)) continue
    }
    const given = params[spec.key]
    const chosen = given ?? ('default' in spec ? spec.default : undefined)
    if (chosen === undefined) continue
    switch (spec.type) {
      case 'enum':
        if (typeof chosen !== 'string' || !spec.values.includes(chosen)) issues.push({ path: `params.${spec.key}`, message: `${spec.label} must be one of: ${spec.values.join(', ')}` })
        else value[spec.key] = chosen
        break
      case 'number': case 'integer':
        if (typeof chosen !== 'number' || !Number.isFinite(chosen) || chosen < spec.min || chosen > spec.max || (spec.type === 'integer' && !Number.isInteger(chosen))) issues.push({ path: `params.${spec.key}`, message: `${spec.label} must be ${spec.type === 'integer' ? 'an integer ' : ''}between ${spec.min} and ${spec.max}` })
        else value[spec.key] = chosen
        break
      case 'boolean':
        if (typeof chosen !== 'boolean') issues.push({ path: `params.${spec.key}`, message: `${spec.label} must be true or false` })
        else value[spec.key] = chosen
        break
      case 'text':
        if (typeof chosen !== 'string') issues.push({ path: `params.${spec.key}`, message: `${spec.label} must be text` })
        else value[spec.key] = chosen
        break
    }
  }
  return { value, issues }
}

/** Up-front cost estimate in USD from pricing data; undefined when it cannot be derived. */
export function estimateUsd(pricing: Pricing | undefined, params: Readonly<Record<string, ParamValue>>, count = 1): number | undefined {
  if (pricing === undefined) return undefined
  const n = Math.max(1, count)
  switch (pricing.unit) {
    case 'image': case 'run': return round(pricing.usd * n)
    case 'second': {
      const seconds = typeof params.duration === 'number' ? params.duration : undefined
      if (seconds === undefined) return undefined
      const keyed = pricing.byParam === undefined ? undefined : pricing.byParam.usd[String(params[pricing.byParam.key])]
      return round((keyed ?? pricing.usd) * seconds * n)
    }
    default: return undefined
  }
}

function round(value: number): number { return Math.round(value * 10_000) / 10_000 }

/** Provider facts the settings UI needs. Secrets are never included; keys are set through the DSH credentials service using `keyRef`. */
export const PROVIDER_INFO: Readonly<Record<'openrouter' | 'replicate' | 'google', { label: string; keyRef: string; getKeyUrl: string; covers: string }>> = {
  openrouter: { label: 'OpenRouter', keyRef: 'OPENROUTER_API_KEY', getKeyUrl: 'https://openrouter.ai/keys', covers: 'Images and video (Veo, Kling, Seedance, Wan, FLUX video upscale)' },
  replicate: { label: 'Replicate', keyRef: 'REPLICATE_API_TOKEN', getKeyUrl: 'https://replicate.com/account/api-tokens', covers: 'Inpainting, upscaling, video edit and extend, long-tail models' },
  google: { label: 'Google Gemini', keyRef: 'GEMINI_API_KEY', getKeyUrl: 'https://aistudio.google.com/apikey', covers: 'Gemini image models direct' },
}
