import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BlobStore, sniffMediaType } from '../../src/v2/assets/blobs.js'
import { StudioDb, ftsQuery } from '../../src/v2/assets/db.js'
import { AssetService, newId } from '../../src/v2/assets/service.js'

// 1x1 PNG
const PNG = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'))
const PNG2 = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64'))

let dir: string
let db: StudioDb
let service: AssetService
let clock = 1_800_000_000_000
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'studio-assets-'))
  db = new StudioDb(join(dir, 'studio.db'))
  service = new AssetService(db, new BlobStore(dir), { now: () => (clock += 1000) })
})
afterEach(async () => { db.close(); await rm(dir, { recursive: true, force: true }) })

describe('asset store', () => {
  it('stores content-addressed files and dedupes identical bytes on disk', async () => {
    const a = await service.ingestBytes(PNG, 'image/png', { source: 'generated', prompt: 'a red boat', modelId: 'openrouter:x/y' })
    const b = await service.ingestBytes(PNG, 'application/octet-stream', { source: 'generated', prompt: 'another' })
    expect(a.id).not.toBe(b.id)
    expect(a.sha256).toBe(b.sha256)
    expect(a).toMatchObject({ kind: 'image', ext: 'png', mime: 'image/png', width: 1, height: 1 })
    expect((await stat(service.pathOf(a))).size).toBe(PNG.byteLength)
  })

  it('concurrent writers of identical bytes both succeed and leave one blob', async () => {
    const results = await Promise.all(Array.from({ length: 12 }, () => service.ingestBytes(PNG, 'image/png', { source: 'generated' })))
    expect(new Set(results.map(r => r.sha256)).size).toBe(1)
    expect(new Set(results.map(r => r.id)).size).toBe(12)
    const { readdir } = await import('node:fs/promises')
    expect((await readdir(join(dir, 'assets', results[0]!.sha256.slice(0, 2)))).filter(f => f.endsWith('.tmp'))).toEqual([])
  })

  it('trusts magic bytes over the declared type and rejects unknown data', async () => {
    expect(sniffMediaType(PNG)).toBe('image/png')
    const asset = await service.ingestBytes(PNG, 'image/jpeg', { source: 'import' })
    expect(asset.mime).toBe('image/png')
    await expect(service.ingestBytes(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]), 'text/plain', { source: 'import' })).rejects.toThrow(/Unsupported/)
  })

  it('records lineage edges and walks the whole component', async () => {
    const root = await service.ingestBytes(PNG, 'image/png', { source: 'generated' })
    const child = await service.ingestBytes(PNG2, 'image/png', { source: 'generated', parents: [{ assetId: root.id, role: 'source' }] })
    const grandchild = await service.ingestBytes(new Uint8Array([...PNG, 0]), 'image/png', { source: 'derived', parents: [{ assetId: child.id, role: 'upscale-of' }] })
    expect(db.parents(child.id)).toEqual([{ childId: child.id, parentId: root.id, role: 'source', ord: 0 }])
    expect(db.children(root.id).map(e => e.childId)).toEqual([child.id])
    const { nodes, edges } = db.lineage(grandchild.id)
    expect(nodes.map(n => n.id).sort()).toEqual([root.id, child.id, grandchild.id].sort())
    expect(edges).toHaveLength(2)
  })

  it('filters, tags, favourites and full-text search over prompts', async () => {
    const a = await service.ingestBytes(PNG, 'image/png', { source: 'generated', prompt: 'A watercolor lighthouse at dawn', tags: ['Sea'], modelId: 'm1', provider: 'openrouter' })
    const b = await service.ingestBytes(PNG2, 'image/png', { source: 'generated', prompt: 'neon city street, rain', modelId: 'm2', provider: 'replicate' })
    db.updateAsset(b.id, { favorite: true })
    db.addTag(b.id, 'Cyberpunk')
    expect(db.queryAssets({ query: 'lighthouse' }).items.map(x => x.id)).toEqual([a.id])
    expect(db.queryAssets({ query: 'neo' }).items.map(x => x.id)).toEqual([b.id])
    expect(db.queryAssets({ query: 'cyberpunk' }).items.map(x => x.id)).toEqual([b.id])
    expect(db.queryAssets({ favorite: true }).items.map(x => x.id)).toEqual([b.id])
    expect(db.queryAssets({ tag: 'sea' }).items.map(x => x.id)).toEqual([a.id])
    expect(db.queryAssets({ provider: 'replicate' }).total).toBe(1)
    expect(db.queryAssets({ kind: 'video' }).total).toBe(0)
    expect(ftsQuery('a "quoted" OR -x')).not.toContain('OR')
  })

  it('soft delete hides an asset from search and purge removes unreferenced blobs only', async () => {
    const a = await service.ingestBytes(PNG, 'image/png', { source: 'generated', prompt: 'gone soon' })
    const b = await service.ingestBytes(PNG, 'image/png', { source: 'generated', prompt: 'same bytes kept' })
    await service.softDelete(a.id)
    expect(db.queryAssets({ query: 'gone' }).total).toBe(0)
    clock += 10_000
    await service.purge(1000)
    expect(db.getAsset(a.id)).toBeUndefined()
    expect((await stat(service.pathOf(b))).size).toBeGreaterThan(0)
    await service.softDelete(b.id); clock += 10_000
    expect(await service.purge(1000)).toBeGreaterThan(0)
    await expect(stat(service.pathOf(b))).rejects.toThrow()
  })

  it('reports spend per day and provider and storage stats', async () => {
    await service.ingestBytes(PNG, 'image/png', { source: 'generated', provider: 'openrouter', costUsd: 0.03 })
    await service.ingestBytes(PNG2, 'image/png', { source: 'generated', provider: 'openrouter', costUsd: 0.02 })
    const spend = db.spend()
    expect(spend).toHaveLength(1)
    expect(spend[0]).toMatchObject({ provider: 'openrouter', usd: 0.05, count: 2 })
    expect(db.storageStats()).toMatchObject({ count: 2, images: 2, videos: 0 })
  })

  it('collections preserve order and settings round-trip', async () => {
    const a = await service.ingestBytes(PNG, 'image/png', { source: 'generated' })
    const b = await service.ingestBytes(PNG2, 'image/png', { source: 'generated' })
    db.createCollection('c1', 'Boats', clock)
    db.addToCollection('c1', b.id); db.addToCollection('c1', a.id)
    expect(db.collectionAssets('c1').map(x => x.id)).toEqual([b.id, a.id])
    expect(db.listCollections()).toEqual([{ id: 'c1', name: 'Boats', count: 2 }])
    db.setSetting('k', 'v1'); db.setSetting('k', 'v2')
    expect(db.getSetting('k')).toBe('v2')
  })

  it('refuses unsafe download URLs and invalid blob addresses', async () => {
    await expect(service.download('http://evil.example/x.png')).rejects.toThrow(/non-HTTPS/)
    expect(() => new BlobStore(dir).pathFor('../../etc/passwd', 'png')).toThrow()
    expect(() => new BlobStore(dir).pathFor('a'.repeat(64), '../x')).toThrow()
  })

  it('ids are unique and time-sortable', () => {
    const a = newId(1_000_000); const b = newId(2_000_000)
    expect(a).toHaveLength(26); expect(a < b).toBe(true)
    expect(new Set(Array.from({ length: 500 }, () => newId(5))).size).toBe(500)
  })
})

describe('remembered public URLs', () => {
  it('returns a URL only while it is valid with a safety margin, and only https', async () => {
    const d = await mkdtemp(join(tmpdir(), 'studio-url-')); const database = new StudioDb(join(d, 's.db'))
    const svc = new AssetService(database, new BlobStore(d))
    svc.rememberPublicUrl('A1', 'https://x.example/a.mp4', 1_000_000)
    svc.rememberPublicUrl('A2', 'http://insecure.example/a.mp4', 1_000_000)
    expect(svc.publicUrl('A1', 500_000)).toBe('https://x.example/a.mp4')
    expect(svc.publicUrl('A1', 900_000)).toBeUndefined()
    expect(svc.publicUrl('A2', 0)).toBeUndefined()
    expect(svc.publicUrl('nope', 0)).toBeUndefined()
    database.close(); await rm(d, { recursive: true, force: true })
  })
})
