// Minimal QR Code encoder: byte mode, error-correction level M, versions 1-10 (up to 213 bytes). No dependencies.
// Written for the pairing screen, where the payload is one short link. Algorithm per ISO/IEC 18004.
// Verified with an external decoder (zbarimg) in tests/qr.spec.ts notes and manual checks; see docs/APPS.md.

export interface QrCode {
  /** Modules per side (21 for version 1, +4 per version). */
  readonly size: number
  readonly version: number
  /** Row-major dark-module flags, `size * size` long. */
  readonly modules: readonly boolean[]
}

/** Level M: [data codewords total, EC codewords per block, [blockCount, dataPerBlock][]] per version 1..10. */
const M_TABLE: readonly (readonly [number, number, readonly (readonly [number, number])[]])[] = [
  [16, 10, [[1, 16]]],
  [28, 16, [[1, 28]]],
  [44, 26, [[1, 44]]],
  [64, 18, [[2, 32]]],
  [86, 24, [[2, 43]]],
  [108, 16, [[4, 27]]],
  [124, 18, [[4, 31]]],
  [154, 22, [[2, 38], [2, 39]]],
  [182, 22, [[3, 36], [2, 37]]],
  [216, 26, [[4, 43], [1, 44]]],
]

const ALIGNMENT: readonly (readonly number[])[] = [
  [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50],
]

export const MAX_BYTES = 213

/** GF(256) with the QR polynomial 0x11D. */
const EXP = new Uint8Array(512)
const LOG = new Uint8Array(256)
;(() => {
  let x = 1
  for (let i = 0; i < 255; i += 1) {
    EXP[i] = x
    LOG[x] = i
    x <<= 1
    if (x & 0x100) x ^= 0x11d
  }
  for (let i = 255; i < 512; i += 1) EXP[i] = EXP[i - 255]!
})()

function gfMul(a: number, b: number): number {
  return a === 0 || b === 0 ? 0 : EXP[LOG[a]! + LOG[b]!]!
}

/** Reed-Solomon remainder of `data` for a generator of `degree` roots. */
export function reedSolomon(data: readonly number[], degree: number): number[] {
  let generator = [1]
  for (let i = 0; i < degree; i += 1) {
    const next = new Array<number>(generator.length + 1).fill(0)
    for (let j = 0; j < generator.length; j += 1) {
      next[j] = (next[j] ?? 0) ^ gfMul(generator[j]!, EXP[i]!)
      next[j + 1] = (next[j + 1] ?? 0) ^ generator[j]!
    }
    generator = next
  }
  // `generator` is little-endian here (index = power); divide MSB-first.
  const gen = generator.slice().reverse().slice(1)
  const result = new Array<number>(degree).fill(0)
  for (const byte of data) {
    const factor = byte ^ result.shift()!
    result.push(0)
    for (let i = 0; i < degree; i += 1) result[i] = (result[i] ?? 0) ^ gfMul(gen[i]!, factor)
  }
  return result
}

function utf8(text: string): number[] {
  return [...new TextEncoder().encode(text)]
}

function appendBits(bits: number[], value: number, length: number): void {
  for (let i = length - 1; i >= 0; i -= 1) bits.push((value >>> i) & 1)
}

function bchRemainder(value: number, generator: number, degree: number): number {
  let r = value << degree
  const top = Math.floor(Math.log2(generator))
  for (let i = Math.floor(Math.log2(Math.max(r, 1))); i >= top; i -= 1) {
    if ((r >>> i) & 1) r ^= generator << (i - top)
  }
  return r
}

class Grid {
  readonly modules: boolean[]
  readonly reserved: boolean[]
  readonly size: number
  constructor(size: number) {
    this.size = size
    this.modules = new Array<boolean>(size * size).fill(false)
    this.reserved = new Array<boolean>(size * size).fill(false)
  }
  set(x: number, y: number, dark: boolean, reserve = true): void {
    this.modules[y * this.size + x] = dark
    if (reserve) this.reserved[y * this.size + x] = true
  }
  get(x: number, y: number): boolean { return this.modules[y * this.size + x]! }
  isReserved(x: number, y: number): boolean { return this.reserved[y * this.size + x]! }
}

function drawFinder(grid: Grid, cx: number, cy: number): void {
  for (let dy = -4; dy <= 4; dy += 1) {
    for (let dx = -4; dx <= 4; dx += 1) {
      const x = cx + dx
      const y = cy + dy
      if (x < 0 || y < 0 || x >= grid.size || y >= grid.size) continue
      const dist = Math.max(Math.abs(dx), Math.abs(dy))
      grid.set(x, y, dist !== 2 && dist !== 4)
    }
  }
}

function drawAlignment(grid: Grid, cx: number, cy: number): void {
  for (let dy = -2; dy <= 2; dy += 1) {
    for (let dx = -2; dx <= 2; dx += 1) grid.set(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1)
  }
}

function drawFunctionPatterns(grid: Grid, version: number): void {
  const size = grid.size
  for (let i = 0; i < size; i += 1) {
    grid.set(6, i, i % 2 === 0)
    grid.set(i, 6, i % 2 === 0)
  }
  drawFinder(grid, 3, 3)
  drawFinder(grid, size - 4, 3)
  drawFinder(grid, 3, size - 4)
  const positions = ALIGNMENT[version - 1]!
  for (let i = 0; i < positions.length; i += 1) {
    for (let j = 0; j < positions.length; j += 1) {
      const lastIndex = positions.length - 1
      if ((i === 0 && j === 0) || (i === 0 && j === lastIndex) || (i === lastIndex && j === 0)) continue
      drawAlignment(grid, positions[i]!, positions[j]!)
    }
  }
  drawFormat(grid, 0) // reserve; real bits are written after the mask is chosen
  if (version >= 7) drawVersion(grid, version)
}

function drawFormat(grid: Grid, mask: number): void {
  const size = grid.size
  const data = (0 << 3) | mask // error-correction level M = 00
  const bits = ((data << 10) | bchRemainder(data, 0x537, 10)) ^ 0x5412
  const bit = (i: number): boolean => ((bits >>> i) & 1) !== 0
  for (let i = 0; i <= 5; i += 1) grid.set(8, i, bit(i))
  grid.set(8, 7, bit(6))
  grid.set(8, 8, bit(7))
  grid.set(7, 8, bit(8))
  for (let i = 9; i < 15; i += 1) grid.set(14 - i, 8, bit(i))
  for (let i = 0; i < 8; i += 1) grid.set(size - 1 - i, 8, bit(i))
  for (let i = 8; i < 15; i += 1) grid.set(8, size - 15 + i, bit(i))
  grid.set(8, size - 8, true) // the fixed dark module
}

function drawVersion(grid: Grid, version: number): void {
  const bits = (version << 12) | bchRemainder(version, 0x1f25, 12)
  for (let i = 0; i < 18; i += 1) {
    const dark = ((bits >>> i) & 1) !== 0
    const a = grid.size - 11 + (i % 3)
    const b = Math.floor(i / 3)
    grid.set(a, b, dark)
    grid.set(b, a, dark)
  }
}

function placeData(grid: Grid, codewords: readonly number[]): void {
  const size = grid.size
  let index = 0
  const total = codewords.length * 8
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5
    for (let vert = 0; vert < size; vert += 1) {
      for (let j = 0; j < 2; j += 1) {
        const x = right - j
        const upward = ((right + 1) & 2) === 0
        const y = upward ? size - 1 - vert : vert
        if (grid.isReserved(x, y) || index >= total) continue
        grid.set(x, y, ((codewords[index >>> 3]! >>> (7 - (index & 7))) & 1) !== 0, false)
        index += 1
      }
    }
  }
}

function maskApplies(mask: number, x: number, y: number): boolean {
  switch (mask) {
    case 0: return (x + y) % 2 === 0
    case 1: return y % 2 === 0
    case 2: return x % 3 === 0
    case 3: return (x + y) % 3 === 0
    case 4: return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0
    case 5: return ((x * y) % 2) + ((x * y) % 3) === 0
    case 6: return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0
    default: return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0
  }
}

function applyMask(grid: Grid, mask: number): void {
  for (let y = 0; y < grid.size; y += 1) {
    for (let x = 0; x < grid.size; x += 1) {
      if (!grid.isReserved(x, y) && maskApplies(mask, x, y)) grid.set(x, y, !grid.get(x, y), false)
    }
  }
}

function penalty(grid: Grid): number {
  const size = grid.size
  let score = 0
  const line = (get: (i: number) => boolean): void => {
    let run = 1
    for (let i = 1; i < size; i += 1) {
      if (get(i) === get(i - 1)) { run += 1; if (run === 5) score += 3; else if (run > 5) score += 1 } else run = 1
    }
    // 1:1:3:1:1 finder-like patterns with 4 light modules on a side.
    for (let i = 0; i + 10 < size; i += 1) {
      const p = (k: number): boolean => get(i + k)
      const core = p(0) && !p(1) && p(2) && p(3) && p(4) && !p(5) && p(6)
      if (core && !p(7) && !p(8) && !p(9) && !p(10)) score += 40
      const rev = p(4) && !p(5) && p(6) && p(7) && p(8) && !p(9) && p(10)
      if (rev && !p(3) && !p(2) && !p(1) && !p(0)) score += 40
    }
  }
  for (let y = 0; y < size; y += 1) line((i) => grid.get(i, y))
  for (let x = 0; x < size; x += 1) line((i) => grid.get(x, i))
  for (let y = 0; y < size - 1; y += 1) {
    for (let x = 0; x < size - 1; x += 1) {
      const c = grid.get(x, y)
      if (c === grid.get(x + 1, y) && c === grid.get(x, y + 1) && c === grid.get(x + 1, y + 1)) score += 3
    }
  }
  const dark = grid.modules.filter(Boolean).length
  const percent = (dark * 100) / (size * size)
  score += Math.floor(Math.abs(percent - 50) / 5) * 10
  return score
}

/** Encode `text` (UTF-8, byte mode, level M). Throws if it does not fit in 213 bytes. */
export function encodeQr(text: string): QrCode {
  const bytes = utf8(text)
  let version = 0
  for (let v = 1; v <= 10; v += 1) {
    const capacity = M_TABLE[v - 1]![0] * 8 - 4 - (v <= 9 ? 8 : 16)
    if (bytes.length * 8 <= capacity) { version = v; break }
  }
  if (version === 0) throw new Error(`QR payload too long (${bytes.length} bytes, max ${MAX_BYTES})`)
  const [dataTotal, ecPerBlock, blockGroups] = M_TABLE[version - 1]!

  const bits: number[] = []
  appendBits(bits, 0b0100, 4)
  appendBits(bits, bytes.length, version <= 9 ? 8 : 16)
  for (const b of bytes) appendBits(bits, b, 8)
  appendBits(bits, 0, Math.min(4, dataTotal * 8 - bits.length))
  while (bits.length % 8 !== 0) bits.push(0)
  const data: number[] = []
  for (let i = 0; i < bits.length; i += 8) data.push(parseInt(bits.slice(i, i + 8).join(''), 2))
  for (let pad = 0xec; data.length < dataTotal; pad ^= 0xec ^ 0x11) data.push(pad)

  const blocks: { data: number[]; ec: number[] }[] = []
  let offset = 0
  for (const [count, length] of blockGroups) {
    for (let i = 0; i < count; i += 1) {
      const chunk = data.slice(offset, offset + length)
      offset += length
      blocks.push({ data: chunk, ec: reedSolomon(chunk, ecPerBlock) })
    }
  }
  const codewords: number[] = []
  const maxData = Math.max(...blocks.map((b) => b.data.length))
  for (let i = 0; i < maxData; i += 1) for (const b of blocks) if (i < b.data.length) codewords.push(b.data[i]!)
  for (let i = 0; i < ecPerBlock; i += 1) for (const b of blocks) codewords.push(b.ec[i]!)

  const size = 17 + 4 * version
  let best: Grid | undefined
  let bestScore = Infinity
  for (let mask = 0; mask < 8; mask += 1) {
    const grid = new Grid(size)
    drawFunctionPatterns(grid, version)
    placeData(grid, codewords)
    applyMask(grid, mask)
    drawFormat(grid, mask)
    const score = penalty(grid)
    if (score < bestScore) { bestScore = score; best = grid }
  }
  return { size, version, modules: best!.modules }
}

/** An SVG path (`M x y h1 v1 h-1 z` per dark module, quiet zone of 4 included) for a crisp scalable code. */
export function qrPath(code: QrCode, quiet = 4): { path: string; viewBox: string } {
  let path = ''
  for (let y = 0; y < code.size; y += 1) {
    let x = 0
    while (x < code.size) {
      if (!code.modules[y * code.size + x]) { x += 1; continue }
      let run = 1
      while (x + run < code.size && code.modules[y * code.size + x + run]) run += 1
      path += `M${x + quiet} ${y + quiet}h${run}v1h-${run}z`
      x += run
    }
  }
  const total = code.size + quiet * 2
  return { path, viewBox: `0 0 ${total} ${total}` }
}
