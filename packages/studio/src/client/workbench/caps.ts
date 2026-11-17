// Operation → required capabilities → input tray slots. Mirrors v2/contracts.capabilitiesFor without a runtime import.
import type { AssetRecord, Capability, MediaKind, ModelDescriptor, OperationRequest } from './types.js'

export type UiOp = 'generate' | 'edit' | 'upscale' | 'animate' | 'restyle' | 'extend'
export type SlotKey = 'source' | 'references' | 'firstFrame' | 'lastFrame' | 'video'

export const OPS_BY_KIND: Record<MediaKind, readonly UiOp[]> = {
  image: ['generate', 'edit', 'upscale'],
  video: ['generate', 'animate', 'restyle', 'extend', 'upscale'],
}

export interface TraySlot { key: SlotKey; labelKey: 'sourceTray' | 'referencesTray' | 'firstFrameTray' | 'lastFrameTray' | 'videoTray'; accepts: MediaKind; multiple: boolean; required: boolean }

export function slotsFor(kind: MediaKind, op: UiOp): TraySlot[] {
  const src: TraySlot = { key: 'source', labelKey: 'sourceTray', accepts: 'image', multiple: false, required: true }
  const refs: TraySlot = { key: 'references', labelKey: 'referencesTray', accepts: 'image', multiple: true, required: false }
  if (kind === 'image') {
    if (op === 'generate') return [refs]
    if (op === 'edit') return [src, refs]
    return [src]
  }
  const first = (required: boolean): TraySlot => ({ key: 'firstFrame', labelKey: 'firstFrameTray', accepts: 'image', multiple: false, required })
  const last: TraySlot = { key: 'lastFrame', labelKey: 'lastFrameTray', accepts: 'image', multiple: false, required: false }
  const video: TraySlot = { key: 'video', labelKey: 'videoTray', accepts: 'video', multiple: false, required: true }
  if (op === 'generate') return [first(false), last]
  if (op === 'animate') return [first(true), last]
  return [video]
}

export type TrayInputs = Partial<Record<SlotKey, AssetRecord[]>>

export function neededCapabilities(kind: MediaKind, op: UiOp, inputs: TrayInputs): Capability[] {
  const has = (key: SlotKey): boolean => (inputs[key]?.length ?? 0) > 0
  if (kind === 'video') {
    switch (op) {
      case 'generate': return has('firstFrame') && has('lastFrame') ? ['first-last-frame'] : has('firstFrame') ? ['i2v'] : ['t2v']
      case 'animate': return has('lastFrame') ? ['first-last-frame'] : ['i2v']
      case 'restyle': return ['v2v']
      case 'extend': return ['extend']
      default: return ['upscale-video']
    }
  }
  switch (op) {
    case 'generate': return has('references') ? ['i2i'] : ['t2i']
    case 'edit': return ['i2i']
    default: return ['upscale-image']
  }
}

export function modelKind(model: Pick<ModelDescriptor, 'capabilities'>): MediaKind {
  return model.capabilities.some(c => c === 't2v' || c === 'i2v' || c === 'v2v' || c === 'extend' || c === 'upscale-video' || c === 'first-last-frame') ? 'video' : 'image'
}

export function compatibleModels(models: readonly ModelDescriptor[], kind: MediaKind, op: UiOp, inputs: TrayInputs): ModelDescriptor[] {
  const needed = neededCapabilities(kind, op, inputs)
  return models.filter(m => modelKind(m) === kind && !(m.deprecated ?? false) && needed.every(c => m.capabilities.includes(c)))
}

/** Maximum files a slot takes for the chosen model (references use the model's limit). */
export function slotMax(slot: TraySlot, model: ModelDescriptor | undefined): number {
  if (!slot.multiple) return 1
  return model?.inputs.images?.max ?? 8
}

/** Build the OperationRequest body the host validates. */
export function buildRequest(args: {
  kind: MediaKind; op: UiOp; modelId: string; prompt: string; negativePrompt: string; params: Record<string, string | number | boolean>; inputs: TrayInputs; tags?: string[]
}): Record<string, unknown> {
  const { kind, op, inputs } = args
  const id = (key: SlotKey): { assetId: string } | undefined => { const a = inputs[key]?.[0]; return a === undefined ? undefined : { assetId: a.id } }
  const out: Record<string, Record<string, unknown>> = { inputs: {} }
  const set = (field: string, value: unknown): void => { if (value !== undefined) out.inputs![field] = value }
  if (kind === 'image') {
    set('source', id('source'))
    if ((inputs.references?.length ?? 0) > 0) set('references', inputs.references!.map(a => ({ assetId: a.id })))
  } else if (op === 'generate' || op === 'animate') {
    set('firstFrame', id('firstFrame')); set('lastFrame', id('lastFrame'))
  } else set('video', id('video'))
  return {
    op, modelId: args.modelId, ...(args.prompt.trim() === '' ? {} : { prompt: args.prompt.trim() }),
    ...(args.negativePrompt.trim() === '' ? {} : { negativePrompt: args.negativePrompt.trim() }),
    inputs: out.inputs, params: args.params, ...(args.tags === undefined || args.tags.length === 0 ? {} : { tags: args.tags }),
  }
}

export function missingInputs(kind: MediaKind, op: UiOp, inputs: TrayInputs): TraySlot[] {
  return slotsFor(kind, op).filter(slot => slot.required && (inputs[slot.key]?.length ?? 0) === 0)
}

export function requestToOp(request: Pick<OperationRequest, 'op'>): UiOp {
  return request.op === 'inpaint' ? 'edit' : request.op
}
