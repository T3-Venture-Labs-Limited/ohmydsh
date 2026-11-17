import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createCore, type StudioCore } from '../../src/v2/core.js'
import { importLegacy, importVaultOrphans, legacyStatus, MAX_BATCH } from '../../src/v2/legacy-import.js'

const png = (rgb: [number, number, number]): Promise<Buffer> => sharp({ create: { width: 4, height: 3, channels: 3, background: { r: rgb[0], g: rgb[1], b: rgb[2] } } }).png().toBuffer()
const gif = async (): Promise<Buffer> => sharp({ create: { width: 4, height: 3, channels: 3, background: { r: 9, g: 9, b: 9 } } }).gif().toBuffer()
const ref = (id: string, bytes: number) => ({ attachmentId: id, mediaType: 'image/png', bytes, width: 4, height: 3 })

let dir: string; let core: StudioCore; let vault: string; const attachments = new Map<string, Uint8Array>()
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'studio-legacy-')); core = createCore({ root: join(dir, 'studio') }); vault = join(dir, 'vault'); attachments.clear() })
afterEach(async () => { await core.close(); await rm(dir, { recursive: true, force: true }) })
const deps = () => ({ readAttachment: async (r: { attachmentId: unknown }): Promise<Uint8Array> => { const b = attachments.get(String(r.attachmentId)); if (b === undefined) throw new Error('gone'); return b }, vaultDirs: [vault] })

describe('legacy gallery import', () => {
  it('imports records with prompt, provider, favourites, tags and original timestamps; idempotent on re-run', async () => {
    const a = new Uint8Array(await png([200, 10, 10])); attachments.set('att-1', a)
    const item = { id: 'g1', attachment: ref('att-1', a.length), prompt: 'a red fox', provider: 'grok-sub', model: 'grok-imagine-image-2.0', createdAt: 1_700_000_000_000, isFavorite: true, tags: ['fox', 'Red'], aspectRatio: '1:1', seed: 7, sessionId: 's-1' }
    const first = await importLegacy(core, deps(), { items: [item] })
    expect(first.items).toEqual([{ id: 'g1', status: 'imported', assetId: expect.any(String) }])
    const asset = core.db.getAsset(first.items[0]!.assetId!)!
    expect(asset).toMatchObject({ source: 'generated', prompt: 'a red fox', provider: 'grok-sub', modelId: 'grok-sub:grok-imagine-image-2.0', favorite: true, createdAt: 1_700_000_000_000, seed: 7, sessionId: 's-1', params: { aspect_ratio: '1:1' } })
    expect(asset.tags.sort()).toEqual(['fox', 'legacy', 'red'])
    const again = await importLegacy(core, deps(), { items: [item] })
    expect(again.items).toEqual([{ id: 'g1', status: 'skipped', assetId: asset.id }])
    expect(core.db.queryAssets({}).total).toBe(1)
  })

  it('prefers the raw vault original over the normalized attachment, and marks user uploads as imports', async () => {
    const g = new Uint8Array(await gif()); const key = createHash('sha256').update(g).digest('hex')
    await mkdir(join(vault, key.slice(0, 2)), { recursive: true }); await writeFile(join(vault, key.slice(0, 2), `${key}.gif`), g)
    const flat = new Uint8Array(await png([1, 2, 3])); attachments.set('att-g', flat)
    const r = await importLegacy(core, deps(), { items: [{ id: 'anim', attachment: ref('att-g', flat.length), provider: 'import', original: { key, mediaType: 'image/gif' } }] })
    const asset = core.db.getAsset(r.items[0]!.assetId!)!
    expect(asset).toMatchObject({ mime: 'image/gif', source: 'import', sha256: key })
  })

  it('reports missing files and bad records without failing the batch; unknown providers are dropped, not trusted', async () => {
    const ok = new Uint8Array(await png([5, 5, 5])); attachments.set('att-ok', ok)
    const r = await importLegacy(core, deps(), { items: [
      { id: 'gone', attachment: ref('att-nope', 10) }, { id: '../../etc', attachment: ref('att-ok', 1) }, { id: 'noatt' },
      { id: 'ok', attachment: ref('att-ok', ok.length), provider: 'made-up', model: 'x' },
      { id: 'junk', attachment: ref('att-junk', 4) },
    ] })
    attachments.set('att-junk', new Uint8Array([1, 2, 3, 4]))
    expect(r.items.map(i => [i.id, i.status])).toEqual([['gone', 'missing'], ['../../etc', 'failed'], ['noatt', 'missing'], ['ok', 'imported'], ['junk', 'missing']])
    const asset = core.db.getAsset(r.items.find(i => i.id === 'ok')!.assetId!)!
    expect(asset.provider).toBeUndefined(); expect(asset.modelId).toBeUndefined()
    const junk = await importLegacy(core, deps(), { items: [{ id: 'junk', attachment: ref('att-junk', 4) }] })
    expect(junk.items[0]).toMatchObject({ status: 'failed', error: 'Unrecognised image data' })
  })

  it('rebuilds edit chains across batches through the attachment ids of the sources', async () => {
    const a = new Uint8Array(await png([10, 10, 10])); const b = new Uint8Array(await png([20, 20, 20])); attachments.set('att-a', a); attachments.set('att-b', b)
    const one = await importLegacy(core, deps(), { items: [{ id: 'orig', attachment: ref('att-a', a.length), prompt: 'base' }] })
    const two = await importLegacy(core, deps(), { items: [{ id: 'edit', attachment: ref('att-b', b.length), prompt: 'edit', sourceAttachmentIds: ['att-a', 'unknown'] }] })
    expect(two.linked).toBe(1)
    expect(core.db.parents(two.items[0]!.assetId!)).toEqual([{ childId: two.items[0]!.assetId, parentId: one.items[0]!.assetId, role: 'source', ord: 0 }])
  })

  it('imports favourite prompts once, ignores junk, caps the batch size, and reports vault status', async () => {
    const r = await importLegacy(core, deps(), { items: [], prompts: [{ id: 'p1', text: ' a lighthouse ', addedAt: 5 }, { id: 'p1', text: 'again' }, { id: 'bad id!', text: 'x' }, { id: 'p2', text: '' }, { id: 'p3', text: 'x'.repeat(9000) }, 'junk'] })
    expect(r.prompts).toEqual({ imported: 1, skipped: 1 })
    expect(core.db.listPrompts().map(p => p.text)).toEqual(['a lighthouse'])
    await expect(importLegacy(core, deps(), { items: Array.from({ length: MAX_BATCH + 1 }, (_, i) => ({ id: `i${String(i)}` })) })).rejects.toThrow(/At most 25/)
    const g = new Uint8Array(await gif()); const key = createHash('sha256').update(g).digest('hex')
    await mkdir(join(vault, key.slice(0, 2)), { recursive: true }); await writeFile(join(vault, key.slice(0, 2), `${key}.gif`), g)
    expect(await legacyStatus(core, { vaultDirs: [vault] })).toMatchObject({ vaultFiles: 1, importedItems: 0 })
  })

  it('imports vault originals nobody referenced, skips ones already stored, caps each call and counts what remains', async () => {
    const files = [await png([1, 1, 1]), await png([2, 2, 2]), await png([3, 3, 3])].map(b => new Uint8Array(b))
    for (const b of files) { const key = createHash('sha256').update(b).digest('hex'); await mkdir(join(vault, key.slice(0, 2)), { recursive: true }); await writeFile(join(vault, key.slice(0, 2), `${key}.png`), b) }
    await mkdir(join(vault, 'zz'), { recursive: true }); await writeFile(join(vault, 'zz', 'notes.txt'), 'ignore me'); await writeFile(join(vault, '.refs.json'), '{}')
    await core.assets.ingestBytes(files[0]!, 'image/png', { source: 'generated' })                // already in the store: must not duplicate
    const first = await importVaultOrphans(core, { vaultDirs: [vault] }, 1)
    expect(first).toEqual({ imported: 1, skipped: 1, remaining: 1 })
    const second = await importVaultOrphans(core, { vaultDirs: [vault] }, 10)
    expect(second.imported).toBe(1); expect(second.remaining).toBe(0)
    expect(core.db.queryAssets({}).total).toBe(3)
    expect(core.db.queryAssets({ tag: 'vault' }).total).toBe(2)
    expect(await importVaultOrphans(core, { vaultDirs: [join(dir, 'nope')] })).toEqual({ imported: 0, skipped: 0, remaining: 0 })
  })
})
