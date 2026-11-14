// Pure canvas logic for the MaskEditor. The mask lives on an alpha canvas of the exact source size; export turns it
// into the contract the host expects: PNG, white = area to change, black = keep (the host inverts per model).
export type MaskOp =
  | { type: 'stroke'; erase: boolean; size: number; pts: readonly [number, number][] }
  | { type: 'rect'; erase: boolean; x: number; y: number; w: number; h: number }
  | { type: 'lasso'; erase: boolean; pts: readonly [number, number][] }
  | { type: 'invert' }
  | { type: 'fill' }
  | { type: 'clear' }

// artwork:start (canvas drawing colours are artwork, not UI chrome)
export const MASK_TINT = '#ff2d95'
const MASK_TINT_DIM = '#ff2d95'
// artwork:end

type Ctx = CanvasRenderingContext2D

export function applyOp(ctx: Ctx, op: MaskOp): void {
  const { width, height } = ctx.canvas
  ctx.save()
  ctx.fillStyle = MASK_TINT; ctx.strokeStyle = MASK_TINT // artwork:ok
  switch (op.type) {
    case 'stroke': {
      ctx.globalCompositeOperation = op.erase ? 'destination-out' : 'source-over'
      ctx.lineWidth = op.size; ctx.lineCap = 'round'; ctx.lineJoin = 'round'
      const [first, ...rest] = op.pts
      if (first === undefined) break
      if (rest.length === 0) { ctx.beginPath(); ctx.arc(first[0], first[1], op.size / 2, 0, Math.PI * 2); ctx.fill(); break }
      ctx.beginPath(); ctx.moveTo(first[0], first[1])
      for (const [x, y] of rest) ctx.lineTo(x, y)
      ctx.stroke(); break
    }
    case 'rect':
      if (op.erase) ctx.clearRect(op.x, op.y, op.w, op.h); else ctx.fillRect(op.x, op.y, op.w, op.h)
      break
    case 'lasso': {
      if (op.pts.length < 3) break
      ctx.globalCompositeOperation = op.erase ? 'destination-out' : 'source-over'
      ctx.beginPath(); ctx.moveTo(op.pts[0]![0], op.pts[0]![1])
      for (const [x, y] of op.pts.slice(1)) ctx.lineTo(x, y)
      ctx.closePath(); ctx.fill(); break
    }
    case 'fill': ctx.globalCompositeOperation = 'source-over'; ctx.fillRect(0, 0, width, height); break
    case 'clear': ctx.clearRect(0, 0, width, height); break
    case 'invert': {
      const tmp = document.createElement('canvas'); tmp.width = width; tmp.height = height
      const t = tmp.getContext('2d')!
      t.fillStyle = MASK_TINT; t.fillRect(0, 0, width, height) // artwork:ok
      t.globalCompositeOperation = 'destination-out'; t.drawImage(ctx.canvas, 0, 0)
      ctx.globalCompositeOperation = 'copy'; ctx.drawImage(tmp, 0, 0); break
    }
  }
  ctx.restore()
}

export function replay(ctx: Ctx, ops: readonly MaskOp[]): void {
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height)
  for (const op of ops) applyOp(ctx, op)
}

/** Dilate the painted area by `px` (a hard-edged grow; the host thresholds masks, so soft feathering would be lost). */
export function grow(source: HTMLCanvasElement, px: number): HTMLCanvasElement {
  if (px <= 0) return source
  const out = document.createElement('canvas'); out.width = source.width; out.height = source.height
  const ctx = out.getContext('2d')!
  const steps = Math.max(12, Math.min(48, Math.round(px * 1.5)))
  ctx.drawImage(source, 0, 0)
  for (let ring = 1; ring <= 2; ring++) {
    const r = px * (ring / 2)
    for (let i = 0; i < steps; i++) { const a = (i / steps) * Math.PI * 2; ctx.drawImage(source, Math.cos(a) * r, Math.sin(a) * r) }
  }
  return out
}

/** Alpha canvas -> black/white RGBA pixels (white where painted) and the painted fraction. */
export function toBlackWhite(source: HTMLCanvasElement): { image: ImageData; editedFraction: number } {
  const ctx = source.getContext('2d')!
  const image = ctx.getImageData(0, 0, source.width, source.height)
  const px = image.data
  let on = 0
  for (let i = 0; i < px.length; i += 4) {
    const v = px[i + 3]! >= 128 ? 255 : 0
    if (v === 255) on++
    px[i] = v; px[i + 1] = v; px[i + 2] = v; px[i + 3] = 255
  }
  return { image, editedFraction: on / (px.length / 4) }
}

export async function exportMaskPng(edit: HTMLCanvasElement, growPx: number): Promise<{ blob: Blob; editedFraction: number }> {
  const { image, editedFraction } = toBlackWhite(grow(edit, growPx))
  // The PNG must have NO alpha channel: the host reads an alpha-carrying mask as "opaque = edit", which would make every
  // pixel count as painted. A canvas created with { alpha: false } encodes as opaque RGB, so the host reads luma (white = change).
  const out = document.createElement('canvas'); out.width = image.width; out.height = image.height
  const ctx = out.getContext('2d', { alpha: false })!
  ctx.putImageData(image, 0, 0)
  const blob = await new Promise<Blob | null>(resolve => { out.toBlob(resolve, 'image/png') })
  if (blob === null) throw new Error('Could not encode the mask as PNG')
  return { blob, editedFraction }
}

/** Does the painted fraction need a warning before the host refuses it? */
export function maskWarning(fraction: number): 'empty' | 'full' | undefined {
  if (fraction <= 0) return 'empty'
  if (fraction > 0.98) return 'full'
  return undefined
}

export const clampPoint = (x: number, y: number, w: number, h: number): [number, number] => [Math.min(w, Math.max(0, x)), Math.min(h, Math.max(0, y))]
void MASK_TINT_DIM

/** Painted fraction of an alpha canvas: block-averaged alpha (smoothed downscale), so small areas still count. */
export function fractionOf(source: HTMLCanvasElement): number {
  const size = 128
  const tmp = document.createElement('canvas'); tmp.width = size; tmp.height = size
  const ctx = tmp.getContext('2d', { willReadFrequently: true })!
  ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(source, 0, 0, size, size)
  const data = ctx.getImageData(0, 0, size, size).data
  let sum = 0
  for (let i = 3; i < data.length; i += 4) sum += data[i]! / 255
  return sum / (size * size)
}
