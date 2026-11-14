/** Media probing and derived files: ffprobe/ffmpeg for video, sharp (when installed) for image thumbs. */
import { execFile } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

export interface MediaInfo { width?: number; height?: number; durationMs?: number; fps?: number; hasAudio?: boolean; codec?: string }

/** ffprobe a local file. Returns undefined when ffprobe is missing or the file is unreadable. */
export async function probeFile(path: string, signal?: AbortSignal): Promise<MediaInfo | undefined> {
  try {
    const { stdout } = await run('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', path], { timeout: 30_000, maxBuffer: 4 * 1024 * 1024, ...(signal === undefined ? {} : { signal }) })
    const data = JSON.parse(stdout) as { streams?: { codec_type?: string; codec_name?: string; width?: number; height?: number; r_frame_rate?: string; avg_frame_rate?: string; duration?: string }[]; format?: { duration?: string } }
    const video = data.streams?.find(s => s.codec_type === 'video')
    const audio = data.streams?.some(s => s.codec_type === 'audio')
    const info: MediaInfo = {}
    if (video?.width !== undefined) info.width = video.width
    if (video?.height !== undefined) info.height = video.height
    const duration = Number(data.format?.duration ?? video?.duration)
    if (Number.isFinite(duration) && duration > 0) info.durationMs = Math.round(duration * 1000)
    const fps = parseRate(video?.avg_frame_rate) ?? parseRate(video?.r_frame_rate)
    if (fps !== undefined) info.fps = fps
    if (audio !== undefined) info.hasAudio = audio
    if (video?.codec_name !== undefined) info.codec = video.codec_name
    return info
  } catch { return undefined }
}

function parseRate(value: string | undefined): number | undefined {
  if (value === undefined) return undefined
  const [n, d] = value.split('/').map(Number)
  if (n === undefined || !Number.isFinite(n) || n <= 0) return undefined
  const rate = d === undefined || d === 0 ? n : n / d
  return Math.round(rate * 100) / 100
}

/** Extract one frame as a JPEG poster. */
export async function makePoster(videoPath: string, outPath: string, atSeconds = 0.5, maxEdge = 640): Promise<boolean> {
  await mkdir(dirname(outPath), { recursive: true })
  try {
    await run('ffmpeg', ['-y', '-v', 'error', '-ss', String(atSeconds), '-i', videoPath, '-frames:v', '1', '-vf', `scale='min(${String(maxEdge)},iw)':-2`, '-q:v', '4', outPath], { timeout: 60_000 })
    return true
  } catch {
    try { await run('ffmpeg', ['-y', '-v', 'error', '-i', videoPath, '-frames:v', '1', '-vf', `scale='min(${String(maxEdge)},iw)':-2`, '-q:v', '4', outPath], { timeout: 60_000 }); return true } catch { return false }
  }
}

/** Lossless-ish lanczos upscale via ffmpeg: the free fallback when no model upscaler is configured. */
export async function ffmpegUpscaleImage(inPath: string, outPath: string, factor: number): Promise<boolean> {
  await mkdir(dirname(outPath), { recursive: true })
  try { await run('ffmpeg', ['-y', '-v', 'error', '-i', inPath, '-vf', `scale=iw*${String(factor)}:ih*${String(factor)}:flags=lanczos`, outPath], { timeout: 120_000 }); return true } catch { return false }
}

interface SharpLike { (input: Uint8Array | string): { metadata(): Promise<{ width?: number; height?: number }>; resize(o: object): { webp(o: object): { toBuffer(): Promise<Uint8Array> } } } }
let sharpCache: SharpLike | null | undefined

/** sharp is optional: it exists in the web profile's node_modules but is not a hard dependency of this plugin. */
export async function loadSharp(): Promise<SharpLike | undefined> {
  if (sharpCache !== undefined) return sharpCache ?? undefined
  try {
    const name = 'sharp'
    const module = await import(/* @vite-ignore */ name) as { default?: SharpLike }
    sharpCache = module.default ?? null
  } catch { sharpCache = null }
  return sharpCache ?? undefined
}

/** Probe image dimensions: sharp when present, otherwise a tiny header reader for PNG/JPEG/WebP/GIF. */
export async function probeImage(bytes: Uint8Array): Promise<{ width?: number; height?: number }> {
  const sharp = await loadSharp()
  if (sharp !== undefined) {
    try { const m = await sharp(bytes).metadata(); return { ...(m.width === undefined ? {} : { width: m.width }), ...(m.height === undefined ? {} : { height: m.height }) } } catch { /* fall through */ }
  }
  return readImageSize(bytes) ?? {}
}

export function readImageSize(b: Uint8Array): { width: number; height: number } | undefined {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength)
  if (b.length > 24 && b[0] === 0x89 && b[1] === 0x50) return { width: dv.getUint32(16), height: dv.getUint32(20) }
  if (b.length > 10 && b[0] === 0x47 && b[1] === 0x49) return { width: dv.getUint16(6, true), height: dv.getUint16(8, true) }
  if (b.length > 30 && b[8] === 0x57 && b[9] === 0x45) { // WEBP
    const kind = String.fromCharCode(b[12]!, b[13]!, b[14]!, b[15]!)
    if (kind === 'VP8X') return { width: 1 + (b[24]! | (b[25]! << 8) | (b[26]! << 16)), height: 1 + (b[27]! | (b[28]! << 8) | (b[29]! << 16)) }
    if (kind === 'VP8 ') return { width: dv.getUint16(26, true) & 0x3fff, height: dv.getUint16(28, true) & 0x3fff }
    if (kind === 'VP8L') { const bits = dv.getUint32(21, true); return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 } }
  }
  if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) { i++; continue }
      const marker = b[i + 1]!
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return { height: dv.getUint16(i + 5), width: dv.getUint16(i + 7) }
      i += 2 + dv.getUint16(i + 2)
    }
  }
  return undefined
}

/** WebP thumbnail with sharp when available; otherwise undefined (callers serve the original). */
export async function makeThumb(bytes: Uint8Array, maxEdge: number): Promise<Uint8Array | undefined> {
  const sharp = await loadSharp()
  if (sharp === undefined) return undefined
  try { return await sharp(bytes).resize({ width: maxEdge, height: maxEdge, fit: 'inside', withoutEnlargement: true }).webp({ quality: 78 }).toBuffer() } catch { return undefined }
}
