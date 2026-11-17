/** Strict parsing of untrusted OperationRequest JSON (browser body or model tool arguments). */
import type { Operation, OperationInputs, OperationRequest, ParamValue } from './contracts.js'
import { HttpError } from './routes/http.js'

const OPS: readonly Operation[] = ['generate', 'edit', 'inpaint', 'upscale', 'animate', 'restyle', 'extend']
const ASSET = /^[0-9A-Za-z_-]{8,64}$/

export function parseOperationRequest(raw: unknown, origin: 'ui' | 'agent', sessionId?: string): OperationRequest {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new HttpError(400, 'invalid-request', 'Request must be a JSON object')
  const b = raw as Record<string, unknown>
  if (typeof b.op !== 'string' || !(OPS as readonly string[]).includes(b.op)) throw new HttpError(400, 'invalid-request', `op must be one of ${OPS.join(', ')}`)
  if (typeof b.modelId !== 'string' || !/^[a-z0-9-]+:.+$/i.test(b.modelId) || b.modelId.length > 200) throw new HttpError(400, 'invalid-request', 'modelId must look like provider:model')
  const text = (key: string, max: number): string | undefined => {
    const v = b[key]; if (v === undefined || v === null) return undefined
    if (typeof v !== 'string') throw new HttpError(400, 'invalid-request', `${key} must be text`)
    if (v.length > max) throw new HttpError(400, 'invalid-request', `${key} is longer than ${String(max)} characters`)
    return v
  }
  const prompt = text('prompt', 8000); const negativePrompt = text('negativePrompt', 4000)
  const ref = (v: unknown, path: string): { assetId: string } => {
    const id = typeof v === 'string' ? v : (typeof v === 'object' && v !== null ? (v as { assetId?: unknown }).assetId : undefined)
    if (typeof id !== 'string' || !ASSET.test(id)) throw new HttpError(400, 'invalid-request', `${path} must be an asset id`)
    return { assetId: id }
  }
  const inputsRaw = (typeof b.inputs === 'object' && b.inputs !== null ? b.inputs : {}) as Record<string, unknown>
  const inputs: { -readonly [K in keyof OperationInputs]: OperationInputs[K] } = {}
  if (inputsRaw.source !== undefined) inputs.source = ref(inputsRaw.source, 'inputs.source')
  if (inputsRaw.mask !== undefined) inputs.mask = ref(inputsRaw.mask, 'inputs.mask')
  if (inputsRaw.firstFrame !== undefined) inputs.firstFrame = ref(inputsRaw.firstFrame, 'inputs.firstFrame')
  if (inputsRaw.lastFrame !== undefined) inputs.lastFrame = ref(inputsRaw.lastFrame, 'inputs.lastFrame')
  if (inputsRaw.video !== undefined) inputs.video = ref(inputsRaw.video, 'inputs.video')
  if (inputsRaw.references !== undefined) {
    if (!Array.isArray(inputsRaw.references) || inputsRaw.references.length > 16) throw new HttpError(400, 'invalid-request', 'inputs.references must be a list of at most 16 assets')
    inputs.references = inputsRaw.references.map((r, i) => ref(r, `inputs.references[${String(i)}]`))
  }
  const params: Record<string, ParamValue> = {}
  if (typeof b.params === 'object' && b.params !== null) {
    for (const [k, v] of Object.entries(b.params as Record<string, unknown>)) {
      if (!/^[a-z0-9_]{1,40}$/i.test(k)) throw new HttpError(400, 'invalid-request', `Invalid parameter name "${k.slice(0, 40)}"`)
      if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') params[k] = v
      else throw new HttpError(400, 'invalid-request', `Parameter ${k} must be a string, number or boolean`)
    }
  }
  const tags = Array.isArray(b.tags) ? b.tags.filter((t): t is string => typeof t === 'string' && t.length > 0 && t.length <= 40).slice(0, 20) : undefined
  return { op: b.op as Operation, modelId: b.modelId, ...(prompt === undefined ? {} : { prompt }), ...(negativePrompt === undefined ? {} : { negativePrompt }), inputs, params, ...(tags === undefined ? {} : { tags }), origin, ...(sessionId === undefined ? {} : { sessionId }) }
}
