/**
 * Mask and canvas helpers for inpaint/outpaint. The studio's canonical mask is a PNG with the exact size of its source image:
 * WHITE = repaint, BLACK = keep (the MaskEditor exports this). Adapters ask for the polarity their model needs.
 * Everything here needs sharp (optional dependency); without it the helpers throw an AdapterError('unsupported').
 */
import { AdapterError, type InpaintMode, type MaskPolarity } from '../contracts.js'
import { loadSharp } from './media.js'

interface SharpInstance {
  metadata(): Promise<{ width?: number; height?: number; hasAlpha?: boolean }>
  resize(o: object): SharpInstance
  extend(o: object): SharpInstance
  composite(layers: object[]): SharpInstance
  greyscale(): SharpInstance
  negate(o?: object): SharpInstance
  threshold(v?: number, o?: object): SharpInstance
  flatten(o: object): SharpInstance
  ensureAlpha(a?: number): SharpInstance
  removeAlpha(): SharpInstance
  blur(s?: number): SharpInstance
  png(o?: object): SharpInstance
  jpeg(o?: object): SharpInstance
  raw(): SharpInstance
  toColourspace(c: string): SharpInstance
  toBuffer(): Promise<Uint8Array>
  toBuffer(o: { resolveWithObject: true }): Promise<{ data: Uint8Array; info: { width: number; height: number; channels: number } }>
}
type SharpFn = (input?: Uint8Array | object, options?: object) => SharpInstance

async function sharp(): Promise<SharpFn> {
  const s = await loadSharp()
  if (s === undefined) throw new AdapterError('unsupported', 'Mask and canvas tools need the sharp image library, which is not available in this installation')
  return s as unknown as SharpFn
}

export interface MaskStats { width: number; height: number; editedFraction: number }

/**
 * Normalise an uploaded mask to the canonical form for `size`: single-channel-looking RGB PNG, white = repaint, hard-edged (threshold 128),
 * same pixel size as the source (nearest-neighbour resize when the editor exported another size, so edges stay crisp).
 * Transparent pixels count as "keep". An optional `feather` (px) is applied by `maskForModel`, not here.
 */
export async function normalizeMask(bytes: Uint8Array, size: { width: number; height: number }, options: { alphaMeansEdit?: boolean } = {}): Promise<{ png: Uint8Array; stats: MaskStats }> {
  const s = await sharp()
  const meta = await s(bytes).metadata().catch(() => { throw new AdapterError('invalid', 'The mask is not a readable image') })
  if (meta.width === undefined || meta.height === undefined) throw new AdapterError('invalid', 'The mask has no dimensions')
  let img = s(bytes)
  if (meta.width !== size.width || meta.height !== size.height) img = img.resize({ width: size.width, height: size.height, fit: 'fill', kernel: 'nearest' })
  // Alpha masks (painted strokes on transparency): opaque = edit. Luma masks: bright = edit.
  const useAlpha = options.alphaMeansEdit ?? (meta.hasAlpha === true)
  let grey: Uint8Array
  if (useAlpha) {
    const { data, info } = await img.ensureAlpha().raw().toBuffer({ resolveWithObject: true })
    grey = new Uint8Array(info.width * info.height)
    for (let i = 0; i < grey.length; i++) grey[i] = data[i * 4 + 3]! >= 128 ? 255 : 0
  } else {
    const { data, info } = await img.flatten({ background: { r: 0, g: 0, b: 0 } }).greyscale().raw().toBuffer({ resolveWithObject: true })
    grey = new Uint8Array(info.width * info.height)
    for (let i = 0; i < grey.length; i++) grey[i] = data[i * info.channels]! >= 128 ? 255 : 0
  }
  let edited = 0
  for (const v of grey) if (v === 255) edited++
  const png = await s(grey, { raw: { width: size.width, height: size.height, channels: 1 } }).png({ compressionLevel: 9 }).toBuffer()
  return { png, stats: { ...size, editedFraction: edited / grey.length } }
}

/** The mask in the polarity (and edge softness) a model wants, from a canonical white=repaint mask. */
export async function maskForModel(canonical: Uint8Array, polarity: MaskPolarity | undefined, options: { feather?: number } = {}): Promise<Uint8Array> {
  const s = await sharp()
  let img = s(canonical)
  if (options.feather !== undefined && options.feather > 0.3) img = img.blur(options.feather)
  if (polarity === 'black-edit') img = img.negate({ alpha: false })
  if (polarity === 'alpha') {
    // Transparent = repaint (OpenAI-style edit masks): white -> alpha 0, black -> alpha 255 over the source colours.
    const { data, info } = await s(canonical).greyscale().raw().toBuffer({ resolveWithObject: true })
    const rgba = new Uint8Array(info.width * info.height * 4)
    for (let i = 0; i < info.width * info.height; i++) { const v = data[i * info.channels]!; rgba[i * 4] = 0; rgba[i * 4 + 1] = 0; rgba[i * 4 + 2] = 0; rgba[i * 4 + 3] = v >= 128 ? 0 : 255 }
    return await s(rgba, { raw: { width: info.width, height: info.height, channels: 4 } }).png().toBuffer()
  }
  return await img.png().toBuffer()
}

/** `overlay-prompt` mode for models without a mask input: paint the area semi-transparent magenta over the source and ask for it by colour. */
export async function overlayForPrompt(source: Uint8Array, canonicalMask: Uint8Array): Promise<{ png: Uint8Array; instruction: string }> {
  const s = await sharp()
  const meta = await s(source).metadata()
  const w = meta.width!; const h = meta.height!
  const { data, info } = await s(canonicalMask).resize({ width: w, height: h, fit: 'fill', kernel: 'nearest' }).greyscale().raw().toBuffer({ resolveWithObject: true })
  const tint = new Uint8Array(w * h * 4)
  for (let i = 0; i < w * h; i++) { const on = data[i * info.channels]! >= 128; tint[i * 4] = 255; tint[i * 4 + 1] = 0; tint[i * 4 + 2] = 255; tint[i * 4 + 3] = on ? 150 : 0 }
  const overlay = await s(tint, { raw: { width: w, height: h, channels: 4 } }).png().toBuffer()
  const png = await s(source).composite([{ input: overlay }]).png().toBuffer()
  return { png, instruction: 'Only change the area highlighted in magenta in the first image and remove the magenta tint; keep everything else exactly as it is.' }
}

/** `markup` mode (OpenRouter gpt-image): a transparent PNG the same size as the source with the edit area marked in an opaque colour. */
export async function markupFromMask(canonicalMask: Uint8Array): Promise<Uint8Array> {
  const s = await sharp()
  const { data, info } = await s(canonicalMask).greyscale().raw().toBuffer({ resolveWithObject: true })
  const px = info.width * info.height
  const rgba = new Uint8Array(px * 4)
  for (let i = 0; i < px; i++) { const on = data[i * info.channels]! >= 128; rgba[i * 4] = 255; rgba[i * 4 + 1] = 40; rgba[i * 4 + 2] = 40; rgba[i * 4 + 3] = on ? 200 : 0 }
  return await s(rgba, { raw: { width: info.width, height: info.height, channels: 4 } }).png().toBuffer()
}

/**
 * Put the model's output back over the original everywhere the mask says "keep". Models that regenerate the whole frame
 * (every markup/overlay-prompt model, and some mask models) otherwise drift in the untouched area. `feather` blends the seam.
 */
export async function compositeBack(original: Uint8Array, generated: Uint8Array, canonicalMask: Uint8Array, options: { feather?: number } = {}): Promise<Uint8Array> {
  const s = await sharp()
  const meta = await s(original).metadata()
  const w = meta.width!; const h = meta.height!
  const gen = await s(generated).resize({ width: w, height: h, fit: 'fill' }).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  const orig = await s(original).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  let m = s(canonicalMask).resize({ width: w, height: h, fit: 'fill', kernel: 'nearest' }).greyscale()
  if (options.feather !== undefined && options.feather > 0.3) m = m.blur(options.feather)
  const mask = await m.raw().toBuffer({ resolveWithObject: true })
  const out = new Uint8Array(w * h * 4)
  for (let i = 0; i < w * h; i++) {
    const a = mask.data[i * mask.info.channels]! / 255
    for (let c = 0; c < 4; c++) out[i * 4 + c] = Math.round(gen.data[i * 4 + c]! * a + orig.data[i * 4 + c]! * (1 - a))
  }
  return await s(out, { raw: { width: w, height: h, channels: 4 } }).png().toBuffer()
}

export interface Expansion { top?: number; right?: number; bottom?: number; left?: number }

/**
 * Outpaint preparation: grow the canvas of `source` by the given pixels. Returns the expanded image (new area filled by edge
 * replication so models see plausible context rather than a hard border) and the canonical mask (white = new area, plus a small
 * `overlap` band of existing pixels so the seam is repainted coherently).
 */
export async function expandCanvas(source: Uint8Array, by: Expansion, options: { overlap?: number } = {}): Promise<{ image: Uint8Array; mask: Uint8Array; width: number; height: number }> {
  const s = await sharp()
  const meta = await s(source).metadata()
  const w = meta.width; const h = meta.height
  if (w === undefined || h === undefined) throw new AdapterError('invalid', 'The source image has no dimensions')
  const top = Math.round(by.top ?? 0); const right = Math.round(by.right ?? 0); const bottom = Math.round(by.bottom ?? 0); const left = Math.round(by.left ?? 0)
  if ([top, right, bottom, left].some(v => v < 0 || !Number.isFinite(v))) throw new AdapterError('invalid', 'Expansion values must be zero or positive')
  if (top + right + bottom + left === 0) throw new AdapterError('invalid', 'Choose at least one side to expand')
  const nw = w + left + right; const nh = h + top + bottom
  if (nw > 8192 || nh > 8192) throw new AdapterError('invalid', `The expanded image would be ${String(nw)}x${String(nh)}; the limit is 8192 px per side`)
  const overlap = Math.max(0, Math.min(options.overlap ?? 16, Math.floor(Math.min(w, h) / 4)))
  const image = await s(source).extend({ top, bottom, left, right, extendWith: 'copy' }).png().toBuffer()
  const m = new Uint8Array(nw * nh)
  const x0 = left + (left > 0 ? overlap : 0); const x1 = left + w - (right > 0 ? overlap : 0)
  const y0 = top + (top > 0 ? overlap : 0); const y1 = top + h - (bottom > 0 ? overlap : 0)
  for (let y = 0; y < nh; y++) for (let x = 0; x < nw; x++) m[y * nw + x] = x >= x0 && x < x1 && y >= y0 && y < y1 ? 0 : 255
  const mask = await s(m, { raw: { width: nw, height: nh, channels: 1 } }).png({ compressionLevel: 9 }).toBuffer()
  return { image, mask, width: nw, height: nh }
}

/** How a model consumes the mask, decided from its descriptor: the single place inpaint routing is defined. */
export function inpaintRoute(model: { inpaintMode?: InpaintMode; maskPolarity?: MaskPolarity }): { mode: InpaintMode; polarity: MaskPolarity } {
  return { mode: model.inpaintMode ?? 'mask', polarity: model.maskPolarity ?? 'white-edit' }
}
