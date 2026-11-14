import sharp from 'sharp'
import { describe, expect, it } from 'vitest'
import { compositeBack, expandCanvas, inpaintRoute, markupFromMask, maskForModel, normalizeMask, overlayForPrompt } from '../../src/v2/assets/masks.js'

/** 4x2 canvas: left half white (repaint), right half black (keep). */
const canonical = async (): Promise<Uint8Array> => sharp(Buffer.from([255, 255, 0, 0, 255, 255, 0, 0]), { raw: { width: 4, height: 2, channels: 1 } }).png().toBuffer()
const solid = (w: number, h: number, rgb: [number, number, number]): Promise<Uint8Array> => sharp({ create: { width: w, height: h, channels: 3, background: { r: rgb[0], g: rgb[1], b: rgb[2] } } }).png().toBuffer()
const px = async (png: Uint8Array): Promise<{ w: number; h: number; ch: number; data: Uint8Array }> => { const r = await sharp(png).raw().toBuffer({ resolveWithObject: true }); return { w: r.info.width, h: r.info.height, ch: r.info.channels, data: r.data } }
/** First channel of pixel i (luma for masks). */
const luma = (p: { ch: number; data: Uint8Array }, i: number): number => p.data[i * p.ch]!
const lumas = (p: { w: number; h: number; ch: number; data: Uint8Array }): number[] => Array.from({ length: p.w * p.h }, (_, i) => luma(p, i))

describe('normalizeMask', () => {
  it('keeps white = repaint, thresholds soft strokes and reports the edited fraction', async () => {
    const soft = await sharp(Buffer.from([255, 200, 120, 10, 255, 200, 120, 10]), { raw: { width: 4, height: 2, channels: 1 } }).png().toBuffer()
    const { png, stats } = await normalizeMask(soft, { width: 4, height: 2 })
    const p = await px(png)
    expect(lumas(p).slice(0, 4)).toEqual([255, 255, 0, 0])
    expect(stats).toEqual({ width: 4, height: 2, editedFraction: 0.5 })
  })

  it('resizes a differently-sized export to the source size with hard edges', async () => {
    const big = await sharp(Buffer.from([255, 0, 0, 255]), { raw: { width: 2, height: 2, channels: 1 } }).png().toBuffer()
    const { png } = await normalizeMask(big, { width: 8, height: 8 })
    const p = await px(png)
    expect(p.w).toBe(8); expect(p.h).toBe(8)
    expect(new Set(lumas(p))).toEqual(new Set([0, 255]))
  })

  it('treats opaque pixels of a transparent PNG as repaint and transparent pixels as keep', async () => {
    const rgba = await sharp(Buffer.from([255, 0, 0, 255, 0, 0, 0, 0, 255, 0, 0, 255, 0, 0, 0, 0]), { raw: { width: 4, height: 1, channels: 4 } }).png().toBuffer()
    const { png, stats } = await normalizeMask(rgba, { width: 4, height: 1 })
    expect(lumas(await px(png))).toEqual([255, 0, 255, 0])
    expect(stats.editedFraction).toBe(0.5)
  })

  it('rejects unreadable input with an invalid error', async () => {
    await expect(normalizeMask(new Uint8Array([1, 2, 3]), { width: 4, height: 4 })).rejects.toMatchObject({ kind: 'invalid' })
  })
})

describe('maskForModel polarity', () => {
  it('white-edit passes through, black-edit inverts, alpha makes the repaint area transparent', async () => {
    const c = await canonical()
    const white = await px(await maskForModel(c, 'white-edit'))
    const black = await px(await maskForModel(c, 'black-edit'))
    expect([luma(white, 0), luma(white, 3)]).toEqual([255, 0])
    expect([luma(black, 0), luma(black, 3)]).toEqual([0, 255])
    const alpha = await px(await maskForModel(c, 'alpha'))
    expect(alpha.ch).toBe(4)
    expect([alpha.data[3], alpha.data[3 * 4 + 3]]).toEqual([0, 255])
  })

  it('feather softens the edge but leaves the interior alone', async () => {
    const wide = await sharp(Buffer.concat([Buffer.alloc(8, 255), Buffer.alloc(8, 0)]), { raw: { width: 16, height: 1, channels: 1 } }).png().toBuffer()
    const soft = await px(await maskForModel(wide, 'white-edit', { feather: 2 }))
    expect(luma(soft, 0)).toBe(255)
    expect(luma(soft, 15)).toBe(0)
    expect(luma(soft, 7)).toBeGreaterThan(0); expect(luma(soft, 7)).toBeLessThan(255)
  })
})

describe('modes', () => {
  it('overlayForPrompt tints only the repaint area; markupFromMask is transparent elsewhere', async () => {
    const src = await solid(4, 2, [0, 200, 0]); const c = await canonical()
    const { png, instruction } = await overlayForPrompt(src, c)
    const o = await px(png)
    expect(o.data[0]).toBeGreaterThan(100); expect(o.data[1]).toBeLessThan(200)        // left pixel: tinted toward magenta
    expect([o.data[3 * o.ch], o.data[3 * o.ch + 1], o.data[3 * o.ch + 2]]).toEqual([0, 200, 0]) // right pixel untouched
    expect(instruction).toMatch(/magenta/)
    const m = await px(await markupFromMask(c))
    expect([m.data[3], m.data[3 * 4 + 3]]).toEqual([200, 0])
  })

  it('inpaintRoute defaults to a white-edit mask and reads the model data', () => {
    expect(inpaintRoute({})).toEqual({ mode: 'mask', polarity: 'white-edit' })
    expect(inpaintRoute({ inpaintMode: 'markup', maskPolarity: 'black-edit' })).toEqual({ mode: 'markup', polarity: 'black-edit' })
  })
})

describe('compositeBack', () => {
  it('keeps generated pixels in the repaint area and original pixels elsewhere, even when the model returns another size', async () => {
    const original = await solid(4, 2, [0, 0, 255]); const generated = await solid(8, 4, [255, 0, 0])
    const out = await px(await compositeBack(original, generated, await canonical()))
    expect([out.w, out.h]).toEqual([4, 2])
    expect([out.data[0], out.data[1], out.data[2]]).toEqual([255, 0, 0])
    expect([out.data[3 * out.ch], out.data[3 * out.ch + 1], out.data[3 * out.ch + 2]]).toEqual([0, 0, 255])
  })
})

describe('expandCanvas (outpaint)', () => {
  it('grows the canvas, replicates the edge and marks the new area plus an overlap band as white', async () => {
    const src = await solid(20, 10, [10, 120, 240])
    const { image, mask, width, height } = await expandCanvas(src, { right: 10, bottom: 6 }, { overlap: 2 })
    expect([width, height]).toEqual([30, 16])
    const i = await px(image); expect([i.w, i.h]).toEqual([30, 16])
    expect([i.data[(29) * i.ch], i.data[(29) * i.ch + 2]]).toEqual([10, 240])      // edge copied into the new strip
    const m = await px(mask)
    const at = (x: number, y: number): number => m.data[(y * m.w + x) * m.ch]!
    expect(at(0, 0)).toBe(0)           // untouched interior
    expect(at(25, 3)).toBe(255)        // new area on the right
    expect(at(5, 12)).toBe(255)        // new area at the bottom
    expect(at(18, 3)).toBe(255)        // overlap band inside the old image, right seam
    expect(at(17, 3)).toBe(0)
    expect(at(3, 8)).toBe(255)         // overlap band, bottom seam
  })

  it('validates input: at least one side, no negatives, size cap', async () => {
    const src = await solid(20, 10, [0, 0, 0])
    await expect(expandCanvas(src, {})).rejects.toMatchObject({ kind: 'invalid' })
    await expect(expandCanvas(src, { left: -3 })).rejects.toMatchObject({ kind: 'invalid' })
    await expect(expandCanvas(src, { right: 9000 })).rejects.toMatchObject({ kind: 'invalid' })
  })
})
