/** Ingests produced files into the content-addressed store and the SQLite index. */
import { randomBytes } from 'node:crypto'
import { writeFile, mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { AdapterError, type AssetEdge, type AssetRecord, type AssetRef, type EdgeRole, type MediaKind, type Operation, type ProducedFile, type ProviderId } from '../contracts.js'
import { BlobStore, extForMime, sniffMediaType } from './blobs.js'
import { StudioDb } from './db.js'
import { makePoster, makeThumb, probeFile, probeImage } from './media.js'

/** 26-char sortable id (48-bit ms time + 80 bits random, Crockford base32). */
export function newId(now = Date.now()): string {
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
  let time = ''; let t = now
  for (let i = 0; i < 10; i++) { time = alphabet[t % 32]! + time; t = Math.floor(t / 32) }
  const rand = randomBytes(10); let r = ''
  for (let i = 0; i < 16; i++) r += alphabet[((rand[Math.floor(i * 5 / 8)]! << 8 | (rand[Math.floor(i * 5 / 8) + 1] ?? 0)) >> (11 - (i * 5 % 8))) & 31]
  return time + r
}

export interface IngestMeta {
  source: AssetRecord['source']
  jobId?: string
  op?: Operation
  provider?: ProviderId
  modelId?: string
  prompt?: string
  negativePrompt?: string
  params?: Readonly<Record<string, unknown>>
  seed?: number
  costUsd?: number
  sessionId?: string
  tags?: readonly string[]
  parents?: readonly { assetId: string; role: EdgeRole; ord?: number }[]
  title?: string
  /** Original creation time (imports keep the legacy timestamp so the gallery order survives). */
  createdAt?: number
  favorite?: boolean
  workspacePath?: string
}

export const MAX_ASSET_BYTES = 2 * 1024 * 1024 * 1024

export class AssetService {
  private readonly listeners = new Set<(asset: AssetRecord) => void>()

  /** Notified after every asset is committed (generation, import, render import, agent). Push channel for live gallery updates. */
  onAsset(listener: (asset: AssetRecord) => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }

  constructor(readonly db: StudioDb, readonly blobs: BlobStore, private readonly options: { fetch?: typeof fetch; now?: () => number; maxBytes?: number } = {}) {}

  private get now(): number { return (this.options.now ?? Date.now)() }

  /** Store bytes already in memory. */
  async ingestBytes(bytes: Uint8Array, declaredType: string | undefined, meta: IngestMeta): Promise<AssetRecord> {
    const mime = sniffMediaType(bytes) ?? (declaredType === undefined ? undefined : declaredType.split(';')[0]!.trim().toLowerCase())
    const ext = mime === undefined ? undefined : extForMime(mime)
    if (mime === undefined || ext === undefined) throw new AdapterError('invalid', `Unsupported or unrecognised media type${declaredType === undefined ? '' : ` (${declaredType})`}`)
    const kind: MediaKind = mime.startsWith('video/') ? 'video' : 'image'
    const stored = await this.blobs.put(bytes, ext)
    return this.record({ sha256: stored.sha256, path: stored.path, ext, mime, kind, bytes: bytes.byteLength }, bytes, meta)
  }

  /** Download a produced file (never trusting the URL), then store it. */
  async ingestProduced(file: ProducedFile, meta: IngestMeta, signal?: AbortSignal): Promise<AssetRecord> {
    let bytes = file.bytes
    if (bytes === undefined) {
      if (file.url === undefined) throw new AdapterError('invalid', 'Provider returned a file with neither bytes nor url')
      bytes = await this.download(file.url, file.headers, signal)
    }
    const asset = await this.ingestBytes(bytes, file.mediaType, { ...meta, ...(file.seed !== undefined && meta.seed === undefined ? { seed: file.seed } : {}) })
    return asset
  }

  async download(url: string, headers: Readonly<Record<string, string>> = {}, signal?: AbortSignal): Promise<Uint8Array> {
    const parsed = new URL(url)
    if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost'))) throw new AdapterError('invalid', 'Refusing a non-HTTPS download URL')
    const response = await (this.options.fetch ?? fetch)(url, { headers: { ...headers }, redirect: 'follow', ...(signal === undefined ? {} : { signal }) })
    if (!response.ok) throw new AdapterError(response.status >= 500 || response.status === 429 ? 'unavailable' : 'invalid', `Download failed with HTTP ${String(response.status)}`, { status: response.status })
    const max = this.options.maxBytes ?? MAX_ASSET_BYTES
    const length = Number(response.headers.get('content-length') ?? 0)
    if (length > max) throw new AdapterError('invalid', `Download is larger than the ${String(Math.round(max / 1048576))} MB limit`)
    const chunks: Uint8Array[] = []; let total = 0
    const reader = response.body?.getReader()
    if (reader === undefined) return new Uint8Array(await response.arrayBuffer())
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > max) { await reader.cancel(); throw new AdapterError('invalid', 'Download exceeded the size limit') }
      chunks.push(value)
    }
    const out = new Uint8Array(total); let offset = 0
    for (const c of chunks) { out.set(c, offset); offset += c.byteLength }
    return out
  }

  private async record(stored: { sha256: string; path: string; ext: string; mime: string; kind: MediaKind; bytes: number }, bytes: Uint8Array | undefined, meta: IngestMeta): Promise<AssetRecord> {
    let info: { width?: number; height?: number; durationMs?: number; fps?: number; hasAudio?: boolean; codec?: string } = {}
    let posterSha: string | undefined
    if (stored.kind === 'image') info = bytes === undefined ? {} : await probeImage(bytes)
    else {
      info = (await probeFile(stored.path)) ?? {}
      const posterPath = this.blobs.derivedPath('poster', stored.sha256)
      if (await makePoster(stored.path, posterPath, Math.min(0.5, (info.durationMs ?? 1000) / 2000))) posterSha = stored.sha256
    }
    const created = meta.createdAt !== undefined && Number.isFinite(meta.createdAt) && meta.createdAt > 0 && meta.createdAt <= this.now ? meta.createdAt : this.now
    const id = newId(created)
    const asset: AssetRecord = {
      id, sha256: stored.sha256, kind: stored.kind, ext: stored.ext, mime: stored.mime, bytes: stored.bytes, createdAt: created, source: meta.source,
      favorite: meta.favorite === true, tags: [...new Set((meta.tags ?? []).map(t => t.trim().toLowerCase()).filter(Boolean))],
      ...info, ...(posterSha === undefined ? {} : { posterSha }),
      ...(meta.jobId === undefined ? {} : { jobId: meta.jobId }), ...(meta.op === undefined ? {} : { op: meta.op }),
      ...(meta.provider === undefined ? {} : { provider: meta.provider }), ...(meta.modelId === undefined ? {} : { modelId: meta.modelId }),
      ...(meta.prompt === undefined ? {} : { prompt: meta.prompt }), ...(meta.negativePrompt === undefined ? {} : { negativePrompt: meta.negativePrompt }),
      ...(meta.params === undefined ? {} : { params: meta.params }), ...(meta.seed === undefined ? {} : { seed: meta.seed }),
      ...(meta.costUsd === undefined ? {} : { costUsd: meta.costUsd }), ...(meta.sessionId === undefined ? {} : { sessionId: meta.sessionId }),
      ...(meta.title === undefined ? {} : { title: meta.title }), ...(meta.workspacePath === undefined ? {} : { workspacePath: meta.workspacePath }),
    }
    const edges: AssetEdge[] = (meta.parents ?? []).map((p, i) => ({ childId: id, parentId: p.assetId, role: p.role, ord: p.ord ?? i }))
    this.db.insertAsset(asset, edges)
    for (const listener of this.listeners) { try { listener(asset) } catch { /* a bad listener must not fail an ingest */ } }
    return asset
  }

  pathOf(asset: Pick<AssetRecord, 'sha256' | 'ext'>): string { return this.blobs.pathFor(asset.sha256, asset.ext) }

  /** Remember short provider facts about an asset (never secrets). Keys are validated: they become part of a settings key. */
  remember(assetId: string, key: string, value: string): void {
    if (!/^[a-z][a-z0-9_-]{0,40}$/i.test(key) || value.length > 500) return
    this.db.setSetting(`note:${assetId}:${key}`, value)
  }
  recall(assetId: string, key: string): string | undefined { return this.db.getSetting(`note:${assetId}:${key}`) }

  /** Remember a provider-hosted signed URL for an asset (video inputs on providers that refuse data URLs). */
  rememberPublicUrl(assetId: string, url: string, expiresAt: number): void {
    if (!url.startsWith('https://')) return
    this.db.setSetting(`public-url:${assetId}`, JSON.stringify({ url, expiresAt }))
  }

  /** A still-valid remembered URL (with a 2 minute safety margin), or undefined. */
  publicUrl(assetId: string, now: number = this.now): string | undefined {
    const raw = this.db.getSetting(`public-url:${assetId}`)
    if (raw === undefined) return undefined
    try { const v = JSON.parse(raw) as { url: string; expiresAt: number }; return v.expiresAt - 120_000 > now ? v.url : undefined } catch { return undefined }
  }

  /** Read an asset as an adapter input. */
  async readInput(ref: AssetRef): Promise<{ bytes: Uint8Array; mediaType: string; width?: number; height?: number }> {
    const asset = this.db.getAsset(ref.assetId)
    if (asset === undefined || asset.deletedAt !== undefined) throw new AdapterError('invalid', `Asset ${ref.assetId} was not found`)
    const bytes = await this.blobs.read(asset.sha256, asset.ext)
    return { bytes, mediaType: asset.mime, ...(asset.width === undefined ? {} : { width: asset.width }), ...(asset.height === undefined ? {} : { height: asset.height }) }
  }

  /** Thumbnail bytes (cached on disk) for an image asset; undefined when sharp is unavailable. */
  async thumbFor(asset: AssetRecord, maxEdge: number): Promise<{ path: string } | undefined> {
    if (asset.kind !== 'image') return undefined
    const target = this.blobs.derivedPath('thumb', asset.sha256, String(maxEdge))
    const { stat } = await import('node:fs/promises')
    try { await stat(target); return { path: target } } catch { /* generate */ }
    const thumb = await makeThumb(await this.blobs.read(asset.sha256, asset.ext), maxEdge)
    if (thumb === undefined) return undefined
    await mkdir(join(target, '..'), { recursive: true }); await writeFile(target, thumb)
    return { path: target }
  }

  /** Soft-delete now; the files are removed by purge once nothing references the hash. */
  async softDelete(id: string): Promise<void> { this.db.setDeleted(id, this.now) }

  async purge(olderThanMs: number): Promise<number> {
    const orphans = this.db.purgeDeleted(this.now - olderThanMs)
    let removed = 0
    for (const sha of orphans) {
      for (const ext of ['png', 'jpg', 'webp', 'gif', 'avif', 'svg', 'mp4', 'webm', 'mov', 'mkv']) {
        const path = this.blobs.pathFor(sha, ext)
        const { stat } = await import('node:fs/promises')
        try { await stat(path); await rm(path, { force: true }); removed++ } catch { /* absent */ }
      }
      await rm(this.blobs.derivedPath('poster', sha), { force: true }); await rm(this.blobs.derivedPath('thumb', sha, '320'), { force: true })
    }
    return removed
  }
}
