/** Content-addressed file storage: <root>/assets/<sha[0:2]>/<sha>.<ext>, derived cache in <root>/derived. */
import { createHash, randomBytes } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, rename, rm, stat, writeFile, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export const SHA_PATTERN = /^[a-f0-9]{64}$/

/** Studio data root: honours DSH_HOME like the vault does. */
export function resolveStudioRoot(home?: string): string {
  return join(home?.trim() || process.env.DSH_HOME?.trim() || join(homedir(), '.dsh'), 'studio')
}

export function sha256Of(bytes: Uint8Array): string { return createHash('sha256').update(bytes).digest('hex') }

const EXT_BY_MIME: Readonly<Record<string, string>> = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif', 'image/avif': 'avif', 'image/svg+xml': 'svg',
  'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov', 'video/x-matroska': 'mkv',
}
const MIME_BY_EXT: Readonly<Record<string, string>> = Object.fromEntries(Object.entries(EXT_BY_MIME).map(([m, e]) => [e, m]))

export function extForMime(mime: string): string | undefined { return EXT_BY_MIME[mime.toLowerCase().split(';')[0]!.trim()] }
export function mimeForExt(ext: string): string | undefined { return MIME_BY_EXT[ext.toLowerCase()] }

/** Sniff a media type from magic bytes. Provider-declared types are never trusted blindly. */
export function sniffMediaType(b: Uint8Array): string | undefined {
  const at = (i: number, s: string): boolean => s.split('').every((c, k) => b[i + k] === c.charCodeAt(0))
  if (b.length >= 8 && b[0] === 0x89 && at(1, 'PNG')) return 'image/png'
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg'
  if (b.length >= 12 && at(0, 'RIFF') && at(8, 'WEBP')) return 'image/webp'
  if (b.length >= 6 && (at(0, 'GIF87a') || at(0, 'GIF89a'))) return 'image/gif'
  if (b.length >= 12 && at(4, 'ftyp')) return at(8, 'avif') || at(8, 'avis') ? 'image/avif' : at(8, 'qt  ') ? 'video/quicktime' : 'video/mp4'
  if (b.length >= 4 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return 'video/webm'
  const head = new TextDecoder().decode(b.subarray(0, 256)).trimStart().toLowerCase()
  if (head.startsWith('<svg') || (head.startsWith('<?xml') && head.includes('<svg'))) return 'image/svg+xml'
  return undefined
}

export class BlobStore {
  constructor(readonly root: string) {}

  pathFor(sha: string, ext: string): string {
    if (!SHA_PATTERN.test(sha) || !/^[a-z0-9]{2,5}$/.test(ext)) throw new Error('invalid blob address')
    return join(this.root, 'assets', sha.slice(0, 2), `${sha}.${ext}`)
  }

  derivedPath(kind: 'thumb' | 'poster' | 'preview', sha: string, variant = ''): string {
    if (!SHA_PATTERN.test(sha) || !/^[a-z0-9_-]{0,16}$/.test(variant)) throw new Error('invalid derived address')
    return join(this.root, 'derived', kind, sha.slice(0, 2), `${sha}${variant === '' ? '' : `-${variant}`}.${kind === 'poster' ? 'jpg' : 'webp'}`)
  }

  /** Write bytes atomically; an existing identical blob is kept. */
  async put(bytes: Uint8Array, ext: string): Promise<{ sha256: string; path: string; created: boolean }> {
    const sha256 = sha256Of(bytes)
    const path = this.pathFor(sha256, ext)
    if (await exists(path)) return { sha256, path, created: false }
    await mkdir(dirname(path), { recursive: true })
    const temp = tempName(path)
    try { await writeFile(temp, bytes); await rename(temp, path) } catch (error) {
      await rm(temp, { force: true })
      // Another writer stored the identical content first: that is success, not an error.
      if (await exists(path)) return { sha256, path, created: false }
      throw error
    }
    return { sha256, path, created: true }
  }

  async putFile(sourcePath: string, ext: string): Promise<{ sha256: string; path: string; created: boolean; bytes: number }> {
    const hash = createHash('sha256'); let bytes = 0
    for await (const chunk of createReadStream(sourcePath)) { hash.update(chunk as Buffer); bytes += (chunk as Buffer).length }
    const sha256 = hash.digest('hex'); const path = this.pathFor(sha256, ext)
    if (await exists(path)) return { sha256, path, created: false, bytes }
    await mkdir(dirname(path), { recursive: true })
    const temp = tempName(path)
    const { copyFile } = await import('node:fs/promises')
    try { await copyFile(sourcePath, temp); await rename(temp, path) } catch (error) {
      await rm(temp, { force: true })
      if (await exists(path)) return { sha256, path, created: false, bytes }
      throw error
    }
    return { sha256, path, created: true, bytes }
  }

  async read(sha: string, ext: string): Promise<Uint8Array> { return new Uint8Array(await readFile(this.pathFor(sha, ext))) }
  async size(sha: string, ext: string): Promise<number> { return (await stat(this.pathFor(sha, ext))).size }
  async remove(sha: string, ext: string): Promise<void> { await rm(this.pathFor(sha, ext), { force: true }) }
}

async function exists(path: string): Promise<boolean> { try { await stat(path); return true } catch { return false } }

/** Unique per call: two concurrent writers of identical content must never share a temp file. */
function tempName(path: string): string { return `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp` }
