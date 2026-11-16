/** Asset routes: metadata CRUD, Range streaming keyed by asset id, thumbs, posters, lineage, import. */
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { sniffMediaType } from '../assets/blobs.js'
import { newId } from '../assets/service.js'
import { expandCanvas, normalizeMask } from '../assets/masks.js'
import { ZipStreamWriter, ZipTooLargeError } from '../../zip-stream.js'
import type { StudioCore } from '../core.js'
import { HttpError, fail, json, readJson, sameOrigin, url } from './http.js'

const ID = /^[0-9A-Za-z_-]{8,64}$/

/** Parse a single `bytes=a-b` range. Returns undefined for no header, null for an unsatisfiable/invalid one. */
export function parseRange(header: string | undefined, size: number): { start: number; end: number } | undefined | null {
  if (header === undefined) return undefined
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (m === null) return null
  let start: number; let end: number
  if (m[1] === '' && m[2] === '') return null
  if (m[1] === '') { const suffix = Number(m[2]); if (suffix === 0) return null; start = Math.max(0, size - suffix); end = size - 1 }
  else { start = Number(m[1]); end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1) }
  if (start >= size || start > end) return null
  return { start, end }
}

export async function serveAsset(core: StudioCore, req: IncomingMessage, res: ServerResponse, id: string, variant: 'file' | 'thumb' | 'poster'): Promise<void> {
  if (req.method !== 'GET' && req.method !== 'HEAD') return fail(res, 405, 'method-not-allowed')
  const asset = ID.test(id) ? core.db.getAsset(id) : undefined
  if (asset === undefined || asset.deletedAt !== undefined) return fail(res, 404, 'not-found')
  let path = core.assets.pathOf(asset); let mime = asset.mime; let cache = 'private, max-age=31536000, immutable'
  if (variant === 'poster') {
    if (asset.kind !== 'video' || asset.posterSha === undefined) return fail(res, 404, 'no-poster')
    path = core.blobs.derivedPath('poster', asset.posterSha); mime = 'image/jpeg'
  } else if (variant === 'thumb') {
    const edge = Math.min(1024, Math.max(64, Number(url(req).searchParams.get('w') ?? 320) || 320))
    if (asset.kind === 'video') { if (asset.posterSha === undefined) return fail(res, 404, 'no-poster'); path = core.blobs.derivedPath('poster', asset.posterSha); mime = 'image/jpeg' }
    else {
      const thumb = await core.assets.thumbFor(asset, edge)
      if (thumb !== undefined) { path = thumb.path; mime = 'image/webp' }
    }
  }
  let size: number
  try { size = (await stat(path)).size } catch { return fail(res, 404, 'file-missing') }
  const range = parseRange(req.headers.range, size)
  // The asset's own bytes are served with its sniffed type, never as HTML, and never sniffable by the browser.
  const base = { 'content-type': mime, 'accept-ranges': 'bytes', 'cache-control': cache, 'x-content-type-options': 'nosniff', 'content-disposition': `inline; filename="${asset.id}.${asset.ext}"`, 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox" }
  if (range === null) { res.writeHead(416, { ...base, 'content-range': `bytes */${String(size)}` }); res.end(); return }
  if (range === undefined) { res.writeHead(200, { ...base, 'content-length': String(size) }); if (req.method === 'HEAD') { res.end(); return } }
  else { res.writeHead(206, { ...base, 'content-length': String(range.end - range.start + 1), 'content-range': `bytes ${String(range.start)}-${String(range.end)}/${String(size)}` }); if (req.method === 'HEAD') { res.end(); return } }
  const stream = createReadStream(path, range === undefined ? {} : { start: range.start, end: range.end })
  stream.on('error', () => { if (!res.writableEnded) res.destroy() })
  res.on('close', () => { stream.destroy() })
  stream.pipe(res)
}

/** POST /assets/import: raw bytes as the request body (Content-Type image/* or video/*), metadata in the query string. */
async function importAsset(core: StudioCore, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const MAX = 512 * 1024 * 1024
  const declared = Number(req.headers['content-length'] ?? 0)
  if (declared > MAX) throw new HttpError(413, 'body-too-large')
  const type = (req.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase()
  if (!type.startsWith('image/') && !type.startsWith('video/')) throw new HttpError(415, 'media-required')
  const chunks: Buffer[] = []; let total = 0
  for await (const chunk of req) {
    const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string)
    total += b.length
    if (total > MAX) throw new HttpError(413, 'body-too-large')
    chunks.push(b)
  }
  const p = url(req).searchParams
  const tags = (p.get('tags') ?? '').split(',').map(t => t.trim()).filter(t => t.length > 0 && t.length <= 40).slice(0, 20)
  const title = p.get('title')?.slice(0, 120)
  const bytes = new Uint8Array(Buffer.concat(chunks))
  // User uploads must be recognisable media: the declared Content-Type alone is never enough.
  if (sniffMediaType(bytes) === undefined) throw new HttpError(400, 'unsupported-media', 'The file is not a recognised image or video')
  let asset
  try {
    asset = await core.assets.ingestBytes(bytes, type, { source: 'import', tags, ...(title === null || title === undefined || title === '' ? {} : { title }) })
  } catch (error) { throw new HttpError(400, 'unsupported-media', error instanceof Error ? error.message : undefined) }
  return json(res, 201, { asset })
}

const ZIP_MAX_ASSETS = 500
const ZIP_MAX_BYTES = 4 * 1024 ** 3

const slugOf = (text: string | undefined): string => (text ?? '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)

/** GET /assets/zip?ids=a,b,c or POST {ids}: stored-mode ZIP, one asset in memory at a time; names "<id>-<slug-of-prompt>.<ext>". */
async function zipAssets(core: StudioCore, req: IncomingMessage, res: ServerResponse): Promise<void> {
  let ids: string[]
  if (req.method === 'POST') {
    const body = (await readJson(req, 256 * 1024)) as { ids?: unknown }
    ids = Array.isArray(body.ids) ? body.ids.filter((x): x is string => typeof x === 'string') : []
  } else ids = (url(req).searchParams.get('ids') ?? '').split(',').map(x => x.trim()).filter(Boolean)
  ids = [...new Set(ids)]
  if (ids.length === 0) throw new HttpError(400, 'ids-required')
  if (ids.length > ZIP_MAX_ASSETS) throw new HttpError(400, 'too-many-assets', `At most ${String(ZIP_MAX_ASSETS)} assets per archive`)
  const assets = ids.map(id => (ID.test(id) ? core.db.getAsset(id) : undefined))
  if (assets.some(a => a === undefined || a.deletedAt !== undefined)) throw new HttpError(404, 'not-found')
  const total = assets.reduce((n, a) => n + a!.bytes, 0)
  if (total > ZIP_MAX_BYTES) throw new HttpError(413, 'archive-too-large', 'The selection is larger than 4 GB; export fewer assets')
  res.writeHead(200, { 'content-type': 'application/zip', 'content-disposition': `attachment; filename="studio-${String(ids.length)}-assets.zip"`, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
  const zip = new ZipStreamWriter(res, { maxBytes: ZIP_MAX_BYTES + 64 * 1024 * 1024 })
  res.on('close', () => { zip.markClientClosed() })
  try {
    for (const asset of assets) {
      if (zip.isClosed) return
      const bytes = await core.blobs.read(asset!.sha256, asset!.ext)
      const slug = slugOf(asset!.title ?? asset!.prompt)
      await zip.add(`${asset!.id}${slug === '' ? '' : `-${slug}`}.${asset!.ext}`, Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength))
    }
    await zip.finish()
  } catch (error) {
    // Headers are already sent: the only honest signal left is to abort the connection so the browser reports a failed download.
    if (!(error instanceof ZipTooLargeError) && !zip.isClosed) core.db.setSetting('last-zip-error', error instanceof Error ? error.message : String(error))
    res.destroy()
  }
}

async function readBody(req: IncomingMessage, max: number): Promise<Buffer> {
  const declared = Number(req.headers['content-length'] ?? 0)
  if (declared > max) throw new HttpError(413, 'body-too-large')
  const chunks: Buffer[] = []; let total = 0
  for await (const chunk of req) {
    const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string)
    total += b.length
    if (total > max) throw new HttpError(413, 'body-too-large')
    chunks.push(b)
  }
  return Buffer.concat(chunks)
}

/**
 * POST /masks?source=<assetId>: body = PNG drawn in the MaskEditor (any size; white = repaint, or a transparent PNG with opaque strokes).
 * Stored normalised to the source's exact pixel size, hard-edged, white = repaint, tagged "mask", with a lineage edge to the source.
 * Returns the mask asset plus how much of the frame it selects, so the UI can warn about empty/full masks before spending anything.
 */
async function uploadMask(core: StudioCore, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const sourceId = url(req).searchParams.get('source') ?? ''
  const source = ID.test(sourceId) ? core.db.getAsset(sourceId) : undefined
  if (source === undefined || source.deletedAt !== undefined || source.kind !== 'image') throw new HttpError(404, 'source-not-found', 'The source must be an existing image asset')
  if (source.width === undefined || source.height === undefined) throw new HttpError(400, 'source-unreadable', 'The source image has no readable size')
  if (!(req.headers['content-type'] ?? '').toLowerCase().startsWith('image/png')) throw new HttpError(415, 'png-required', 'Upload the mask as image/png')
  const body = await readBody(req, 64 * 1024 * 1024)
  let normalized
  try { normalized = await normalizeMask(new Uint8Array(body), { width: source.width, height: source.height }) } catch (error) {
    throw new HttpError(error instanceof Error && 'kind' in error && (error as { kind: string }).kind === 'unsupported' ? 503 : 400, 'invalid-mask', error instanceof Error ? error.message : undefined)
  }
  const asset = await core.assets.ingestBytes(normalized.png, 'image/png', { source: 'derived', tags: ['mask'], title: `Mask for ${source.title ?? source.id}`, parents: [{ assetId: source.id, role: 'source' }] })
  return json(res, 201, { asset, stats: normalized.stats })
}

/**
 * POST /assets/expand {assetId, top?, right?, bottom?, left?, overlap?}: outpaint preparation. Creates the expanded image (edge-replicated) and
 * its mask (white = new area + a thin overlap band) as two assets; submit them as an `inpaint` job (source + mask) to fill the new area.
 */
async function expandAsset(core: StudioCore, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const b = (await readJson(req, 16 * 1024)) as Record<string, unknown>
  const id = typeof b.assetId === 'string' && ID.test(b.assetId) ? b.assetId : ''
  const source = id === '' ? undefined : core.db.getAsset(id)
  if (source === undefined || source.deletedAt !== undefined || source.kind !== 'image') throw new HttpError(404, 'source-not-found', 'assetId must be an existing image asset')
  const num = (k: string): number | undefined => { const v = b[k]; if (v === undefined) return undefined; if (typeof v !== 'number' || !Number.isFinite(v)) throw new HttpError(400, 'invalid-request', `${k} must be a number of pixels`); return v }
  let expanded
  try { expanded = await expandCanvas(new Uint8Array(await core.blobs.read(source.sha256, source.ext)), { ...(num('top') === undefined ? {} : { top: num('top')! }), ...(num('right') === undefined ? {} : { right: num('right')! }), ...(num('bottom') === undefined ? {} : { bottom: num('bottom')! }), ...(num('left') === undefined ? {} : { left: num('left')! }) }, num('overlap') === undefined ? {} : { overlap: num('overlap')! }) } catch (error) {
    throw new HttpError(error instanceof Error && 'kind' in error && (error as { kind: string }).kind === 'unsupported' ? 503 : 400, 'invalid-expansion', error instanceof Error ? error.message : undefined)
  }
  const image = await core.assets.ingestBytes(expanded.image, 'image/png', { source: 'derived', title: `${source.title ?? source.id} (expanded)`, tags: ['outpaint'], parents: [{ assetId: source.id, role: 'source' }] })
  const mask = await core.assets.ingestBytes(expanded.mask, 'image/png', { source: 'derived', tags: ['mask'], title: `Mask for ${image.title ?? image.id}`, parents: [{ assetId: image.id, role: 'source' }] })
  return json(res, 201, { image, mask, width: expanded.width, height: expanded.height })
}

/** /assets, /assets/:id, /assets/:id/(file|thumb|poster|lineage|tags|collections), /tags, /collections, /spend, /stats */
export async function serveAssetApi(core: StudioCore, req: IncomingMessage, res: ServerResponse, path: string, agent?: { sessionTitle(id: string): Promise<string | undefined> }): Promise<void> {
  const u = url(req); const method = req.method ?? 'GET'
  const mutating = method !== 'GET' && method !== 'HEAD'
  if (mutating && !sameOrigin(req)) return fail(res, 403, 'origin-rejected')
  try {
    if (path === '/assets' && method === 'GET') {
      const p = u.searchParams
      const q: Parameters<typeof core.db.queryAssets>[0] = { limit: Number(p.get('limit') ?? 60), offset: Number(p.get('offset') ?? 0) }
      const set = <K extends keyof typeof q>(key: K, value: (typeof q)[K] | undefined): void => { if (value !== undefined) q[key] = value }
      set('query', p.get('q') ?? undefined); set('kind', (p.get('kind') as 'image' | 'video' | null) ?? undefined); set('tag', p.get('tag') ?? undefined)
      set('modelId', p.get('model') ?? undefined); set('collection', p.get('collection') ?? undefined); set('provider', p.get('provider') ?? undefined); set('parentOf', p.get('parent') ?? undefined)
      if (p.get('favorite') === '1') q.favorite = true
      if (p.get('fromChats') === '1') q.fromChats = true
      const src = p.get('source'); if (src === 'agent' || src === 'generated' || src === 'import' || src === 'render' || src === 'derived') q.source = src
      if (p.get('since') !== null) q.since = Number(p.get('since')); if (p.get('until') !== null) q.until = Number(p.get('until'))
      return json(res, 200, core.db.queryAssets(q))
    }
    if (path === '/assets/import' && method === 'POST') return await importAsset(core, req, res)
    if (path === '/masks' && method === 'POST') return await uploadMask(core, req, res)
    if (path === '/assets/expand' && method === 'POST') return await expandAsset(core, req, res)
    if (path === '/assets/zip' && (method === 'GET' || method === 'POST')) return await zipAssets(core, req, res)
    if (path === '/tags' && method === 'GET') return json(res, 200, { tags: core.db.allTags() })
    if (path === '/spend' && method === 'GET') return json(res, 200, { spend: core.db.spend(Number(u.searchParams.get('since') ?? 0)) })
    if (path === '/stats' && method === 'GET') return json(res, 200, core.db.storageStats())
    if (path === '/collections') {
      if (method === 'GET') return json(res, 200, { collections: core.db.listCollections() })
      if (method === 'POST') {
        const body = (await readJson(req)) as { name?: unknown }
        const name = typeof body.name === 'string' ? body.name.trim().slice(0, 80) : ''
        if (name.length === 0) throw new HttpError(400, 'name-required')
        const id = newId()
        core.db.createCollection(id, name, Date.now()); return json(res, 201, { id, name })
      }
    }
    const m = /^\/assets\/([^/]+)(?:\/([a-z]+))?$/.exec(path)
    if (m !== null) {
      const id = m[1]!; const sub = m[2]
      if (!ID.test(id)) return fail(res, 404, 'not-found')
      if (sub === 'file' || sub === 'thumb' || sub === 'poster') return serveAsset(core, req, res, id, sub)
      const asset = core.db.getAsset(id)
      if (asset === undefined) return fail(res, 404, 'not-found')
      if (sub === undefined && method === 'GET') {
        // The chat this asset came from (agent capture, or a Studio tool call inside a session), with its current title when the host can tell.
        const chat = asset.sessionId === undefined ? undefined : { id: asset.sessionId, ...(await agent?.sessionTitle(asset.sessionId).catch(() => undefined).then(t => (t === undefined ? {} : { title: t })) ?? {}) }
        return json(res, 200, { asset, parents: core.db.parents(id), children: core.db.children(id), collections: core.db.collectionsOf(id), ...(chat === undefined ? {} : { chat }) })
      }
      if (sub === 'lineage' && method === 'GET') return json(res, 200, core.db.lineage(id))
      if (sub === undefined && method === 'PATCH') {
        const b = (await readJson(req)) as Record<string, unknown>
        core.db.updateAsset(id, {
          ...(typeof b.title === 'string' || b.title === null ? { title: b.title as string | null } : {}), ...(typeof b.favorite === 'boolean' ? { favorite: b.favorite } : {}),
          ...(typeof b.rating === 'number' || b.rating === null ? { rating: b.rating === null ? null : Math.min(5, Math.max(0, Math.round(b.rating))) } : {}), ...(typeof b.notes === 'string' || b.notes === null ? { notes: b.notes as string | null } : {}),
        })
        return json(res, 200, { asset: core.db.getAsset(id) })
      }
      if (sub === undefined && method === 'DELETE') { await core.assets.softDelete(id); return json(res, 200, { ok: true }) }
      if (sub === 'tags' && method === 'POST') {
        const b = (await readJson(req)) as { add?: unknown; remove?: unknown }
        for (const t of Array.isArray(b.add) ? b.add : []) if (typeof t === 'string' && t.trim().length > 0 && t.length <= 40) core.db.addTag(id, t)
        for (const t of Array.isArray(b.remove) ? b.remove : []) if (typeof t === 'string') core.db.removeTag(id, t)
        return json(res, 200, { tags: core.db.tagsOf(id) })
      }
      if (sub === 'collections' && method === 'POST') {
        const b = (await readJson(req)) as { add?: unknown; remove?: unknown }
        if (typeof b.add === 'string') core.db.addToCollection(b.add, id)
        if (typeof b.remove === 'string') core.db.removeFromCollection(b.remove, id)
        return json(res, 200, { ok: true })
      }
    }
    return fail(res, 404, 'not-found')
  } catch (error) {
    if (error instanceof HttpError) return fail(res, error.status, error.code)
    return fail(res, 500, 'server-error', error instanceof Error ? error.message : String(error))
  }
}
