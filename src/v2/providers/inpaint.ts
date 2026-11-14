/** Shared inpaint input preparation: one place decides what a model receives, whatever its inpaintMode. */
import { AdapterError, type AdapterContext, type InpaintMode, type MaskPolarity, type ModelDescriptor, type OperationRequest } from '../contracts.js'
import { inpaintRoute, markupFromMask, maskForModel, normalizeMask, overlayForPrompt } from '../assets/masks.js'

export interface PreparedInpaint {
  mode: InpaintMode
  polarity: MaskPolarity
  /** Original source image (kept so the runner can composite the result back). */
  source: { bytes: Uint8Array; mediaType: string; width?: number; height?: number }
  /** Canonical mask: white = repaint, same size as the source. */
  canonicalMask: Uint8Array
  /** mode "mask": the mask in the model's polarity (PNG). */
  mask?: Uint8Array
  /** mode "markup": transparent PNG marking the edit area. */
  markup?: Uint8Array
  /** mode "overlay-prompt": the source with the area tinted, replacing the source image sent to the model. */
  overlaySource?: Uint8Array
  /** Text appended to the prompt (overlay-prompt). */
  instruction?: string
}

/** Read the source and mask assets, normalise the mask to the source size and build what the model's mode needs. */
export async function prepareInpaint(request: OperationRequest, model: Pick<ModelDescriptor, 'inpaintMode' | 'maskPolarity'>, context: AdapterContext, options: { feather?: number } = {}): Promise<PreparedInpaint> {
  if (request.inputs.source === undefined) throw new AdapterError('invalid', 'Inpainting needs a source image')
  if (request.inputs.mask === undefined) throw new AdapterError('invalid', 'Inpainting needs a mask')
  const source = await context.readInput(request.inputs.source)
  if (source.width === undefined || source.height === undefined) throw new AdapterError('invalid', 'The source image has no readable size')
  const rawMask = await context.readInput(request.inputs.mask)
  const { png: canonicalMask, stats } = await normalizeMask(rawMask.bytes, { width: source.width, height: source.height })
  if (stats.editedFraction === 0) throw new AdapterError('invalid', 'The mask selects nothing: paint the area you want to change')
  if (stats.editedFraction > 0.98) throw new AdapterError('invalid', 'The mask covers the whole image: use an edit instead of an inpaint')
  const { mode, polarity } = inpaintRoute(model)
  const out: PreparedInpaint = { mode, polarity, source, canonicalMask }
  if (mode === 'mask') out.mask = await maskForModel(canonicalMask, polarity, options.feather === undefined ? {} : { feather: options.feather })
  else if (mode === 'markup') out.markup = await markupFromMask(canonicalMask)
  else { const o = await overlayForPrompt(source.bytes, canonicalMask); out.overlaySource = o.png; out.instruction = o.instruction }
  return out
}

/** Prompt with the mode's instruction appended. */
export function promptWith(prompt: string | undefined, prepared: PreparedInpaint): string {
  const base = (prompt ?? '').trim()
  return prepared.instruction === undefined ? base : `${base}${base === '' ? '' : '\n\n'}${prepared.instruction}`
}
