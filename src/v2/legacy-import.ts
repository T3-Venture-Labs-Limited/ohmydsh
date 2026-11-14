/**
 * Import of the old dsh-image-gen gallery into the server asset store.
 * The browser shim reads IndexedDB `dsh_image_gen_db` (record shape = GalleryItem) and POSTs batches; the host reads the bytes itself
 * from the DSH attachment store (by attachment ref) and, for animated/raw originals, from the old content-addressed vault.
 * Idempotent: every legacy id maps to exactly one asset (`legacy:<id>` setting), so re-running imports only what is new.
 */
import { readFile, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { ProviderId } from './contracts.js'
import type { StudioCore } from './core.js'
import { sniffMediaType } from './assets/blobs.js'
import { parseImageAttachmentRef } from '../reference-image.js'
import { isValidVaultKey, readOriginal, resolveDshHome } from '../vault-store.js'

export interface LegacyDeps {
  /** Read stored attachment bytes (DSH attachment service). Throws when the attachment is gone. */
  readAttachment(ref: ImageAttachmentRef): Promise<Uint8Array>
  /** Vault directories to search for raw originals, newest first. */
  vaultDirs?: readonly string[]
  home?: string
}

export interface LegacyItem {
  id: string
  attachment?: unknown
  prompt?: string
  provider?: string
  model?: string
  createdAt?: number
  isFavorite?: boolean
  tags?: string[]
  workspacePath?: string
  sessionId?: string
  sourceAttachmentIds?: string[]
  original?: { key?: string; mediaType?: string }
  seed?: number
  aspectRatio?: string
  imageSize?: string
  resolution?: string
  generationQuality?: string
  output?: string
  channel?: string
  savedTo?: string
}

export interface LegacyPrompt { id: string; text: string; addedAt?: number }

export interface ItemResult { id: string; status: 'imported' | 'skipped' | 'missing' | 'failed'; assetId?: string; error?: string }
export interface ImportReport { items: ItemResult[]; prompts: { imported: number; skipped: number }; linked: number }

const LEGACY_ID = /^[\w.:@-]{1,160}$/
const PROVIDERS: readonly string[] = ['openrouter', 'replicate', 'google', 'grok-sub', 'google-sub', 'comfyui', 'openai', 'openai-compat', 'xai']
export const MAX_BATCH = 25
export const legacyKey = (id: string): string => `legacy:${id}`

/** Where the old plugin kept raw originals (`<home>/image-gen/vault`) plus this plugin's own vault. */
export function defaultVaultDirs(home?: string): string[] { const h = resolveDshHome(home); return [join(h, 'image-gen', 'vault'), join(h, 'studio', 'vault')] }

async function readVault(key: string, dirs: readonly string[], hint?: string): Promise<{ data: Uint8Array; mediaType: string } | undefined> {
  if (!isValidVaultKey(key)) return undefined
  for (const dir of dirs) {
    const found = await readOriginal({ enabled: true, dir }, key, hint)
    if (found !== undefined) return { data: new Uint8Array(found.data), mediaType: found.mediaType }
  }
  return undefined
}

export async function importLegacy(core: StudioCore, deps: LegacyDeps, payload: { items?: unknown; prompts?: unknown }): Promise<ImportReport> {
  const rawItems = Array.isArray(payload.items) ? payload.items : []
  if (rawItems.length > MAX_BATCH) throw new RangeError(`At most ${String(MAX_BATCH)} items per request`)
  const dirs = deps.vaultDirs ?? defaultVaultDirs(deps.home)
  const results: ItemResult[] = []
  const pendingEdges: { child: string; parents: string[] }[] = []
  for (const raw of rawItems) {
    const item = (typeof raw === 'object' && raw !== null ? raw : {}) as LegacyItem
    const id = typeof item.id === 'string' && LEGACY_ID.test(item.id) ? item.id : undefined
    if (id === undefined) { results.push({ id: String(item.id ?? '').slice(0, 40), status: 'failed', error: 'invalid id' }); continue }
    const existing = core.db.getSetting(legacyKey(id))
    if (existing !== undefined && core.db.getAsset(existing) !== undefined) { results.push({ id, status: 'skipped', assetId: existing }); continue }
    try {
      // Prefer the raw original (an animated GIF the attachment layer flattened) over the normalized attachment.
      let bytes: Uint8Array | undefined
      const key = typeof item.original?.key === 'string' ? item.original.key : undefined
      if (key !== undefined) bytes = (await readVault(key, dirs, item.original?.mediaType))?.data
      if (bytes === undefined) {
        const ref = parseImageAttachmentRef(item.attachment)
        if (ref !== undefined) bytes = await deps.readAttachment(ref).catch(() => undefined)
      }
      if (bytes === undefined) { results.push({ id, status: 'missing', error: 'The image file is no longer available' }); continue }
      if (sniffMediaType(bytes) === undefined) { results.push({ id, status: 'failed', error: 'Unrecognised image data' }); continue }
      const provider = typeof item.provider === 'string' && PROVIDERS.includes(item.provider) ? item.provider as ProviderId : undefined
      const imported = item.provider === 'import'
      const params: Record<string, string | number> = {}
      for (const [k, v] of Object.entries({ aspect_ratio: item.aspectRatio, image_size: item.imageSize, resolution: item.resolution, quality: item.generationQuality, output: item.output })) if (typeof v === 'string' && v.length > 0 && v.length < 60) params[k] = v
      const asset = await core.assets.ingestBytes(bytes, undefined, {
        source: imported ? 'import' : 'generated', ...(typeof item.createdAt === 'number' ? { createdAt: item.createdAt } : {}), favorite: item.isFavorite === true,
        ...(typeof item.prompt === 'string' && item.prompt.length > 0 ? { prompt: item.prompt.slice(0, 8000) } : {}), ...(provider === undefined ? {} : { provider }),
        ...(typeof item.model === 'string' && item.model.length > 0 && provider !== undefined ? { modelId: `${provider}:${item.model.slice(0, 120)}` } : {}),
        ...(Object.keys(params).length > 0 ? { params } : {}), ...(typeof item.seed === 'number' ? { seed: item.seed } : {}), ...(typeof item.sessionId === 'string' ? { sessionId: item.sessionId.slice(0, 120) } : {}),
        ...(typeof item.workspacePath === 'string' ? { workspacePath: item.workspacePath.slice(0, 500) } : {}),
        tags: ['legacy', ...(Array.isArray(item.tags) ? item.tags.filter((t): t is string => typeof t === 'string' && t.length > 0 && t.length <= 40).slice(0, 20) : [])],
      })
      core.db.setSetting(legacyKey(id), asset.id)
      const attachmentRef = parseImageAttachmentRef(item.attachment)
      if (attachmentRef !== undefined) core.db.setSetting(`legacy-attachment:${String(attachmentRef.attachmentId)}`, asset.id)
      results.push({ id, status: 'imported', assetId: asset.id })
      if (Array.isArray(item.sourceAttachmentIds)) pendingEdges.push({ child: asset.id, parents: item.sourceAttachmentIds.filter((x): x is string => typeof x === 'string') })
    } catch (error) { results.push({ id, status: 'failed', error: error instanceof Error ? error.message.slice(0, 200) : 'import failed' }) }
  }
  // Edit chains: the legacy record names source ATTACHMENT ids; resolve those through the legacy ids imported so far (any batch).
  let linked = 0
  for (const { child, parents } of pendingEdges) {
    for (const [ord, attachmentId] of parents.entries()) {
      const parent = findByAttachmentRef(core, attachmentId)
      if (parent !== undefined && parent !== child) { core.db.addEdge({ childId: child, parentId: parent, role: 'source', ord }); linked++ }
    }
  }
  const prompts = { imported: 0, skipped: 0 }
  for (const p of Array.isArray(payload.prompts) ? payload.prompts.slice(0, 500) : []) {
    const row = (typeof p === 'object' && p !== null ? p : {}) as LegacyPrompt
    if (typeof row.id !== 'string' || !LEGACY_ID.test(row.id) || typeof row.text !== 'string' || row.text.trim().length === 0 || row.text.length > 8000) continue
    if (core.db.getSetting(`legacy-prompt:${row.id}`) !== undefined) { prompts.skipped++; continue }
    const id = `lp_${row.id.slice(0, 40)}`
    core.db.savePrompt(id, row.text.trim(), null, typeof row.addedAt === 'number' && row.addedAt > 0 ? row.addedAt : Date.now())
    core.db.setSetting(`legacy-prompt:${row.id}`, id); prompts.imported++
  }
  return { items: results, prompts, linked }
}

/** Legacy records reference their sources by attachment id; imports remember the id each asset came from. */
function findByAttachmentRef(core: StudioCore, attachmentId: string): string | undefined {
  const direct = core.db.getSetting(legacyKey(attachmentId))
  return direct !== undefined && core.db.getAsset(direct) !== undefined ? direct : core.db.getSetting(`legacy-attachment:${attachmentId}`)
}

/** What is left to migrate: raw files in the old vault and how many legacy gallery records are already imported. */
export async function legacyStatus(core: StudioCore, deps: Pick<LegacyDeps, 'vaultDirs' | 'home'>): Promise<{ vaultFiles: number; importedItems: number; vaultDirs: string[] }> {
  const dirs = deps.vaultDirs ?? defaultVaultDirs(deps.home)
  let vaultFiles = 0
  for (const dir of dirs.slice(0, 1)) {
    try { for (const shard of await readdir(dir, { withFileTypes: true })) if (shard.isDirectory()) vaultFiles += (await readdir(join(dir, shard.name))).filter(f => /^[a-f0-9]{64}\./.test(f)).length } catch { /* no legacy vault */ }
  }
  const importedItems = core.db.countSettings('legacy:')
  return { vaultFiles, importedItems, vaultDirs: [...dirs] }
}

/**
 * Raw originals in the old vault that no gallery record pointed to (or whose record is gone): import them as plain imports, newest-first,
 * at most `limit` per call. Files whose bytes are already stored are skipped. Returns how many files are left to look at.
 */
export async function importVaultOrphans(core: StudioCore, deps: Pick<LegacyDeps, 'vaultDirs' | 'home'>, limit = 50): Promise<{ imported: number; skipped: number; remaining: number }> {
  const dir = (deps.vaultDirs ?? defaultVaultDirs(deps.home))[0]!
  const files: { path: string; key: string; mtime: number }[] = []
  try {
    for (const shard of await readdir(dir, { withFileTypes: true })) {
      if (!shard.isDirectory()) continue
      for (const name of await readdir(join(dir, shard.name))) {
        const m = /^([a-f0-9]{64})\.(png|jpe?g|webp|gif|avif)$/.exec(name); if (m === null) continue
        const path = join(dir, shard.name, name)
        files.push({ path, key: m[1]!, mtime: (await stat(path)).mtimeMs })
      }
    }
  } catch { return { imported: 0, skipped: 0, remaining: 0 } }
  files.sort((a, b) => b.mtime - a.mtime)
  let imported = 0; let skipped = 0; let processed = 0
  const todo = files.filter(f => { const done = core.db.getSetting(`legacy-vault:${f.key}`) !== undefined || core.db.findBySha(f.key) !== undefined; if (done) skipped++; return !done })
  for (const f of todo.slice(0, Math.max(1, Math.min(limit, 200)))) {
    processed++
    try {
      const bytes = new Uint8Array(await readFile(f.path))
      if (sniffMediaType(bytes) === undefined) { core.db.setSetting(`legacy-vault:${f.key}`, 'unreadable'); skipped++; continue }
      const asset = await core.assets.ingestBytes(bytes, undefined, { source: 'import', createdAt: f.mtime, tags: ['legacy', 'vault'] })
      core.db.setSetting(`legacy-vault:${f.key}`, asset.id); imported++
    } catch { skipped++ }
  }
  return { imported, skipped, remaining: Math.max(0, todo.length - processed) }
}
