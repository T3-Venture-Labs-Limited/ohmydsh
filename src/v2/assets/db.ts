/** SQLite persistence (node:sqlite): assets, lineage edges, tags, collections, prompts, jobs, FTS5, settings. */
import { DatabaseSync, type StatementSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type { AssetEdge, AssetRecord, EdgeRole, JobRecord, JobState, MediaKind, OperationRequest } from '../contracts.js'

export const SCHEMA_VERSION = 1

const MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE assets(
    id TEXT PRIMARY KEY, sha256 TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('image','video')),
    ext TEXT NOT NULL, mime TEXT NOT NULL, bytes INTEGER NOT NULL,
    width INTEGER, height INTEGER, duration_ms INTEGER, fps REAL, has_audio INTEGER, codec TEXT, poster_sha TEXT,
    created_at INTEGER NOT NULL, source TEXT NOT NULL CHECK(source IN ('generated','import','render','derived')),
    job_id TEXT, op TEXT, provider TEXT, model_id TEXT, prompt TEXT, negative_prompt TEXT, params_json TEXT, seed INTEGER,
    cost_usd REAL, title TEXT, favorite INTEGER NOT NULL DEFAULT 0, rating INTEGER, deleted_at INTEGER,
    session_id TEXT, workspace_path TEXT, notes TEXT
  );
  CREATE INDEX assets_created ON assets(created_at DESC);
  CREATE INDEX assets_kind_created ON assets(kind, created_at DESC);
  CREATE INDEX assets_favorite ON assets(favorite) WHERE favorite = 1;
  CREATE INDEX assets_model ON assets(model_id);
  CREATE INDEX assets_sha ON assets(sha256);
  CREATE TABLE asset_edges(
    child_id TEXT NOT NULL, parent_id TEXT NOT NULL, role TEXT NOT NULL, ord INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY(child_id, parent_id, role, ord)
  );
  CREATE INDEX edges_parent ON asset_edges(parent_id);
  CREATE TABLE tags(asset_id TEXT NOT NULL, tag TEXT NOT NULL, PRIMARY KEY(asset_id, tag));
  CREATE INDEX tags_tag ON tags(tag);
  CREATE TABLE collections(id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'manual', created_at INTEGER NOT NULL);
  CREATE TABLE collection_items(collection_id TEXT NOT NULL, asset_id TEXT NOT NULL, ord INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(collection_id, asset_id));
  CREATE TABLE prompts(id TEXT PRIMARY KEY, text TEXT NOT NULL, folder_id TEXT, created_at INTEGER NOT NULL);
  CREATE TABLE jobs(
    id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, started_at INTEGER, finished_at INTEGER, updated_at INTEGER NOT NULL,
    state TEXT NOT NULL, op TEXT NOT NULL, model_id TEXT NOT NULL, provider TEXT NOT NULL,
    request_json TEXT NOT NULL, remote_json TEXT, progress REAL, message TEXT, error_json TEXT, attempt INTEGER NOT NULL DEFAULT 0,
    asset_ids_json TEXT NOT NULL DEFAULT '[]', origin TEXT NOT NULL DEFAULT 'ui', session_id TEXT, agent_job_id TEXT,
    estimate_usd REAL, cost_usd REAL, cost_source TEXT
  );
  CREATE INDEX jobs_state ON jobs(state);
  CREATE INDEX jobs_updated ON jobs(updated_at DESC);
  CREATE TABLE settings_kv(key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE catalog_cache(key TEXT PRIMARY KEY, fetched_at INTEGER NOT NULL, payload TEXT NOT NULL);
  CREATE VIRTUAL TABLE assets_fts USING fts5(prompt, title, tags, notes, content='', contentless_delete=1, tokenize='unicode61 remove_diacritics 2');
  `,
]

export interface AssetQuery {
  query?: string
  kind?: MediaKind
  favorite?: boolean
  tag?: string
  modelId?: string
  provider?: string
  since?: number
  until?: number
  parentOf?: string
  collection?: string
  includeDeleted?: boolean
  limit?: number
  offset?: number
}

export class StudioDb {
  readonly db: DatabaseSync
  private readonly cache = new Map<string, StatementSync>()

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    this.db = new DatabaseSync(path)
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = OFF; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;')
    this.migrate()
  }

  close(): void { this.db.close() }

  private stmt(sql: string): StatementSync {
    let s = this.cache.get(sql)
    if (s === undefined) { s = this.db.prepare(sql); this.cache.set(sql, s) }
    return s
  }

  private migrate(): void {
    const row = this.db.prepare('PRAGMA user_version').get() as { user_version: number }
    for (let v = row.user_version; v < MIGRATIONS.length; v++) {
      this.db.exec('BEGIN')
      try {
        this.db.exec(MIGRATIONS[v]!)
        this.db.exec(`PRAGMA user_version = ${String(v + 1)}`)
        this.db.exec('COMMIT')
      } catch (error) { this.db.exec('ROLLBACK'); throw error }
    }
  }

  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE')
    try { const result = fn(); this.db.exec('COMMIT'); return result } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }

  // ---------- assets ----------
  insertAsset(asset: AssetRecord, edges: readonly AssetEdge[] = []): void {
    this.transaction(() => {
      this.stmt(`INSERT INTO assets(id,sha256,kind,ext,mime,bytes,width,height,duration_ms,fps,has_audio,codec,poster_sha,created_at,source,job_id,op,provider,model_id,prompt,negative_prompt,params_json,seed,cost_usd,title,favorite,rating,deleted_at,session_id,workspace_path,notes)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        asset.id, asset.sha256, asset.kind, asset.ext, asset.mime, asset.bytes,
        asset.width ?? null, asset.height ?? null, asset.durationMs ?? null, asset.fps ?? null, asset.hasAudio === undefined ? null : asset.hasAudio ? 1 : 0, asset.codec ?? null, asset.posterSha ?? null,
        asset.createdAt, asset.source, asset.jobId ?? null, asset.op ?? null, asset.provider ?? null, asset.modelId ?? null,
        asset.prompt ?? null, asset.negativePrompt ?? null, asset.params === undefined ? null : JSON.stringify(asset.params), asset.seed ?? null,
        asset.costUsd ?? null, asset.title ?? null, asset.favorite ? 1 : 0, asset.rating ?? null, asset.deletedAt ?? null,
        asset.sessionId ?? null, asset.workspacePath ?? null, asset.notes ?? null)
      for (const edge of edges) this.addEdge(edge)
      for (const tag of asset.tags) this.stmt('INSERT OR IGNORE INTO tags(asset_id,tag) VALUES(?,?)').run(asset.id, tag)
      this.reindex(asset.id)
    })
  }

  addEdge(edge: AssetEdge): void {
    this.stmt('INSERT OR IGNORE INTO asset_edges(child_id,parent_id,role,ord) VALUES(?,?,?,?)').run(edge.childId, edge.parentId, edge.role, edge.ord)
  }

  private reindex(id: string): void {
    const a = this.stmt('SELECT prompt,title,notes,deleted_at FROM assets WHERE id=?').get(id) as { prompt: string | null; title: string | null; notes: string | null; deleted_at: number | null } | undefined
    const rowid = this.stmt('SELECT rowid FROM assets WHERE id=?').get(id) as { rowid: number } | undefined
    if (a === undefined || rowid === undefined) return
    this.stmt('DELETE FROM assets_fts WHERE rowid=?').run(rowid.rowid)
    if (a.deleted_at !== null) return
    const tags = (this.stmt('SELECT tag FROM tags WHERE asset_id=?').all(id) as { tag: string }[]).map(t => t.tag).join(' ')
    this.stmt('INSERT INTO assets_fts(rowid,prompt,title,tags,notes) VALUES(?,?,?,?,?)').run(rowid.rowid, a.prompt ?? '', a.title ?? '', tags, a.notes ?? '')
  }

  getAsset(id: string): AssetRecord | undefined {
    const row = this.stmt('SELECT * FROM assets WHERE id=?').get(id) as Row | undefined
    return row === undefined ? undefined : this.toAsset(row)
  }

  findBySha(sha256: string): AssetRecord | undefined {
    const row = this.stmt('SELECT * FROM assets WHERE sha256=? AND deleted_at IS NULL ORDER BY created_at LIMIT 1').get(sha256) as Row | undefined
    return row === undefined ? undefined : this.toAsset(row)
  }

  updateAsset(id: string, patch: { title?: string | null; favorite?: boolean; rating?: number | null; notes?: string | null; workspacePath?: string | null; posterSha?: string | null }): void {
    const sets: string[] = []; const values: (string | number | null)[] = []
    if (patch.title !== undefined) { sets.push('title=?'); values.push(patch.title) }
    if (patch.favorite !== undefined) { sets.push('favorite=?'); values.push(patch.favorite ? 1 : 0) }
    if (patch.rating !== undefined) { sets.push('rating=?'); values.push(patch.rating) }
    if (patch.notes !== undefined) { sets.push('notes=?'); values.push(patch.notes) }
    if (patch.workspacePath !== undefined) { sets.push('workspace_path=?'); values.push(patch.workspacePath) }
    if (patch.posterSha !== undefined) { sets.push('poster_sha=?'); values.push(patch.posterSha) }
    if (sets.length === 0) return
    this.db.prepare(`UPDATE assets SET ${sets.join(',')} WHERE id=?`).run(...values, id)
    this.reindex(id)
  }

  setDeleted(id: string, deletedAt: number | null): void {
    this.stmt('UPDATE assets SET deleted_at=? WHERE id=?').run(deletedAt, id)
    this.reindex(id)
  }

  /** Hard-delete rows soft-deleted before `before`; returns the content hashes no remaining asset references. */
  purgeDeleted(before: number): string[] {
    return this.transaction(() => {
      const rows = this.stmt('SELECT id,sha256,poster_sha FROM assets WHERE deleted_at IS NOT NULL AND deleted_at < ?').all(before) as { id: string; sha256: string; poster_sha: string | null }[]
      const orphan = new Set<string>()
      for (const row of rows) {
        const rowid = this.stmt('SELECT rowid FROM assets WHERE id=?').get(row.id) as { rowid: number }
        this.stmt('DELETE FROM assets_fts WHERE rowid=?').run(rowid.rowid)
        this.stmt('DELETE FROM assets WHERE id=?').run(row.id)
        this.stmt('DELETE FROM tags WHERE asset_id=?').run(row.id)
        this.stmt('DELETE FROM asset_edges WHERE child_id=? OR parent_id=?').run(row.id, row.id)
        this.stmt('DELETE FROM collection_items WHERE asset_id=?').run(row.id)
        orphan.add(row.sha256); if (row.poster_sha !== null) orphan.add(row.poster_sha)
      }
      return [...orphan].filter(sha => (this.stmt('SELECT 1 FROM assets WHERE sha256=? OR poster_sha=? LIMIT 1').get(sha, sha)) === undefined)
    })
  }

  addTag(id: string, tag: string): void { this.stmt('INSERT OR IGNORE INTO tags(asset_id,tag) VALUES(?,?)').run(id, tag.trim().toLowerCase()); this.reindex(id) }
  removeTag(id: string, tag: string): void { this.stmt('DELETE FROM tags WHERE asset_id=? AND tag=?').run(id, tag.trim().toLowerCase()); this.reindex(id) }
  tagsOf(id: string): string[] { return (this.stmt('SELECT tag FROM tags WHERE asset_id=? ORDER BY tag').all(id) as { tag: string }[]).map(t => t.tag) }
  allTags(): { tag: string; count: number }[] { return this.stmt('SELECT tag, COUNT(*) AS count FROM tags GROUP BY tag ORDER BY count DESC, tag').all() as { tag: string; count: number }[] }

  parents(id: string): AssetEdge[] { return (this.stmt('SELECT child_id,parent_id,role,ord FROM asset_edges WHERE child_id=? ORDER BY role,ord').all(id) as unknown as EdgeRow[]).map(toEdge) }
  children(id: string): AssetEdge[] { return (this.stmt('SELECT child_id,parent_id,role,ord FROM asset_edges WHERE parent_id=? ORDER BY child_id').all(id) as unknown as EdgeRow[]).map(toEdge) }

  /** Whole lineage component reachable from an asset (ancestors and descendants), capped. */
  lineage(id: string, cap = 200): { nodes: AssetRecord[]; edges: AssetEdge[] } {
    const seen = new Set<string>([id]); const queue = [id]; const edges: AssetEdge[] = []
    while (queue.length > 0 && seen.size < cap) {
      const current = queue.shift()!
      for (const edge of [...this.parents(current), ...this.children(current)]) {
        if (!edges.some(e => e.childId === edge.childId && e.parentId === edge.parentId && e.role === edge.role && e.ord === edge.ord)) edges.push(edge)
        for (const next of [edge.childId, edge.parentId]) if (!seen.has(next)) { seen.add(next); queue.push(next) }
      }
    }
    const nodes = [...seen].map(x => this.getAsset(x)).filter((a): a is AssetRecord => a !== undefined)
    return { nodes, edges }
  }

  queryAssets(q: AssetQuery): { items: AssetRecord[]; total: number } {
    const where: string[] = []; const args: (string | number)[] = []
    let from = 'assets a'
    if (q.query !== undefined && q.query.trim().length > 0) {
      from = 'assets a JOIN assets_fts f ON f.rowid = a.rowid'
      where.push('assets_fts MATCH ?'); args.push(ftsQuery(q.query))
    }
    if (q.includeDeleted !== true) where.push('a.deleted_at IS NULL')
    if (q.kind !== undefined) { where.push('a.kind=?'); args.push(q.kind) }
    if (q.favorite === true) where.push('a.favorite=1')
    if (q.tag !== undefined) { where.push('EXISTS(SELECT 1 FROM tags t WHERE t.asset_id=a.id AND t.tag=?)'); args.push(q.tag.toLowerCase()) }
    if (q.modelId !== undefined) { where.push('a.model_id=?'); args.push(q.modelId) }
    if (q.provider !== undefined) { where.push('a.provider=?'); args.push(q.provider) }
    if (q.since !== undefined) { where.push('a.created_at>=?'); args.push(q.since) }
    if (q.until !== undefined) { where.push('a.created_at<?'); args.push(q.until) }
    if (q.collection !== undefined) { where.push('EXISTS(SELECT 1 FROM collection_items ci WHERE ci.asset_id=a.id AND ci.collection_id=?)'); args.push(q.collection) }
    if (q.parentOf !== undefined) { where.push('EXISTS(SELECT 1 FROM asset_edges e WHERE e.child_id=a.id AND e.parent_id=?)'); args.push(q.parentOf) }
    const clause = where.length === 0 ? '' : `WHERE ${where.join(' AND ')}`
    const total = (this.db.prepare(`SELECT COUNT(*) AS n FROM ${from} ${clause}`).get(...args) as { n: number }).n
    const limit = Math.min(Math.max(q.limit ?? 50, 1), 500)
    const rows = this.db.prepare(`SELECT a.* FROM ${from} ${clause} ORDER BY a.created_at DESC, a.id DESC LIMIT ? OFFSET ?`).all(...args, limit, q.offset ?? 0) as unknown as Row[]
    return { items: rows.map(row => this.toAsset(row)), total }
  }

  /** Spend per UTC day and provider over assets with a recorded cost. */
  spend(since = 0): { day: string; provider: string; usd: number; count: number }[] {
    return this.stmt(`SELECT strftime('%Y-%m-%d', created_at/1000, 'unixepoch') AS day, COALESCE(provider,'unknown') AS provider, ROUND(SUM(cost_usd),4) AS usd, COUNT(*) AS count
      FROM assets WHERE cost_usd IS NOT NULL AND created_at >= ? GROUP BY day, provider ORDER BY day DESC, provider`).all(since) as { day: string; provider: string; usd: number; count: number }[]
  }

  storageStats(): { count: number; bytes: number; images: number; videos: number } {
    const r = this.stmt(`SELECT COUNT(*) AS count, COALESCE(SUM(bytes),0) AS bytes, SUM(kind='image') AS images, SUM(kind='video') AS videos FROM assets WHERE deleted_at IS NULL`).get() as { count: number; bytes: number; images: number | null; videos: number | null }
    return { count: r.count, bytes: r.bytes, images: r.images ?? 0, videos: r.videos ?? 0 }
  }

  // ---------- collections ----------
  createCollection(id: string, name: string, now: number): void { this.stmt('INSERT INTO collections(id,name,kind,created_at) VALUES(?,?,?,?)').run(id, name, 'manual', now) }
  listCollections(): { id: string; name: string; count: number }[] {
    return this.stmt('SELECT c.id, c.name, (SELECT COUNT(*) FROM collection_items i WHERE i.collection_id=c.id) AS count FROM collections c ORDER BY c.created_at').all() as { id: string; name: string; count: number }[]
  }
  addToCollection(collectionId: string, assetId: string): void {
    const ord = (this.stmt('SELECT COALESCE(MAX(ord),0)+1 AS n FROM collection_items WHERE collection_id=?').get(collectionId) as { n: number }).n
    this.stmt('INSERT OR IGNORE INTO collection_items(collection_id,asset_id,ord) VALUES(?,?,?)').run(collectionId, assetId, ord)
  }
  removeFromCollection(collectionId: string, assetId: string): void { this.stmt('DELETE FROM collection_items WHERE collection_id=? AND asset_id=?').run(collectionId, assetId) }
  collectionsOf(assetId: string): string[] { return (this.stmt('SELECT collection_id FROM collection_items WHERE asset_id=? ORDER BY collection_id').all(assetId) as { collection_id: string }[]).map(r => r.collection_id) }
  collectionAssets(collectionId: string): AssetRecord[] {
    return (this.stmt('SELECT a.* FROM assets a JOIN collection_items i ON i.asset_id=a.id WHERE i.collection_id=? AND a.deleted_at IS NULL ORDER BY i.ord').all(collectionId) as unknown as Row[]).map(r => this.toAsset(r))
  }

  // ---------- prompts / settings / catalog cache ----------
  savePrompt(id: string, text: string, folderId: string | null, now: number): void { this.stmt('INSERT INTO prompts(id,text,folder_id,created_at) VALUES(?,?,?,?)').run(id, text, folderId, now) }
  listPrompts(): { id: string; text: string; folderId: string | null; createdAt: number }[] {
    return (this.stmt('SELECT id,text,folder_id,created_at FROM prompts ORDER BY created_at DESC').all() as { id: string; text: string; folder_id: string | null; created_at: number }[]).map(p => ({ id: p.id, text: p.text, folderId: p.folder_id, createdAt: p.created_at }))
  }
  /** Number of settings keys with this prefix (the legacy import map). */
  countSettings(prefix: string): number { return (this.stmt("SELECT COUNT(*) n FROM settings_kv WHERE key LIKE ? ESCAPE '\\'").get(prefix.replace(/[\\%_]/g, m => `\\${m}`) + '%') as { n: number }).n }
  deletePrompt(id: string): void { this.stmt('DELETE FROM prompts WHERE id=?').run(id) }
  getSetting(key: string): string | undefined { return (this.stmt('SELECT value FROM settings_kv WHERE key=?').get(key) as { value: string } | undefined)?.value }
  setSetting(key: string, value: string): void { this.stmt('INSERT INTO settings_kv(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value) }
  getCache(key: string): { fetchedAt: number; payload: string } | undefined {
    const r = this.stmt('SELECT fetched_at,payload FROM catalog_cache WHERE key=?').get(key) as { fetched_at: number; payload: string } | undefined
    return r === undefined ? undefined : { fetchedAt: r.fetched_at, payload: r.payload }
  }
  putCache(key: string, payload: string, now: number): void { this.stmt('INSERT INTO catalog_cache(key,fetched_at,payload) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET fetched_at=excluded.fetched_at,payload=excluded.payload').run(key, now, payload) }

  // ---------- jobs ----------
  insertJob(job: JobRecord): void {
    this.stmt(`INSERT INTO jobs(id,created_at,started_at,finished_at,updated_at,state,op,model_id,provider,request_json,remote_json,progress,message,error_json,attempt,asset_ids_json,origin,session_id,agent_job_id,estimate_usd,cost_usd,cost_source)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(...jobParams(job))
  }
  saveJob(job: JobRecord): void {
    this.stmt(`UPDATE jobs SET started_at=?,finished_at=?,updated_at=?,state=?,remote_json=?,progress=?,message=?,error_json=?,attempt=?,asset_ids_json=?,agent_job_id=?,estimate_usd=?,cost_usd=?,cost_source=? WHERE id=?`).run(
      job.startedAt ?? null, job.finishedAt ?? null, job.updatedAt, job.state, job.remote === undefined ? null : JSON.stringify(job.remote), job.progress ?? null, job.message ?? null,
      job.error === undefined ? null : JSON.stringify(job.error), job.attempt, JSON.stringify(job.assetIds), job.agentJobId ?? null, job.estimateUsd ?? null, job.costUsd ?? null, job.costSource ?? null, job.id)
  }
  getJob(id: string): JobRecord | undefined { const r = this.stmt('SELECT * FROM jobs WHERE id=?').get(id) as JobRow | undefined; return r === undefined ? undefined : toJob(r) }
  listJobs(options: { states?: readonly JobState[]; since?: number; limit?: number } = {}): JobRecord[] {
    const where: string[] = []; const args: (string | number)[] = []
    if (options.states !== undefined && options.states.length > 0) { where.push(`state IN (${options.states.map(() => '?').join(',')})`); args.push(...options.states) }
    if (options.since !== undefined) { where.push('updated_at > ?'); args.push(options.since) }
    const clause = where.length === 0 ? '' : `WHERE ${where.join(' AND ')}`
    return (this.db.prepare(`SELECT * FROM jobs ${clause} ORDER BY updated_at DESC LIMIT ?`).all(...args, Math.min(options.limit ?? 100, 500)) as unknown as JobRow[]).map(toJob)
  }

  private toAsset(row: Row): AssetRecord {
    const asset: AssetRecord = {
      id: row.id, sha256: row.sha256, kind: row.kind, ext: row.ext, mime: row.mime, bytes: row.bytes, createdAt: row.created_at, source: row.source,
      favorite: row.favorite === 1, tags: this.tagsOf(row.id),
    }
    const opt = asset as unknown as Record<string, unknown>
    if (row.width !== null) opt.width = row.width
    if (row.height !== null) opt.height = row.height
    if (row.duration_ms !== null) opt.durationMs = row.duration_ms
    if (row.fps !== null) opt.fps = row.fps
    if (row.has_audio !== null) opt.hasAudio = row.has_audio === 1
    if (row.codec !== null) opt.codec = row.codec
    if (row.poster_sha !== null) opt.posterSha = row.poster_sha
    if (row.job_id !== null) opt.jobId = row.job_id
    if (row.op !== null) opt.op = row.op
    if (row.provider !== null) opt.provider = row.provider
    if (row.model_id !== null) opt.modelId = row.model_id
    if (row.prompt !== null) opt.prompt = row.prompt
    if (row.negative_prompt !== null) opt.negativePrompt = row.negative_prompt
    if (row.params_json !== null) opt.params = JSON.parse(row.params_json)
    if (row.seed !== null) opt.seed = row.seed
    if (row.cost_usd !== null) opt.costUsd = row.cost_usd
    if (row.title !== null) opt.title = row.title
    if (row.rating !== null) opt.rating = row.rating
    if (row.deleted_at !== null) opt.deletedAt = row.deleted_at
    if (row.session_id !== null) opt.sessionId = row.session_id
    if (row.workspace_path !== null) opt.workspacePath = row.workspace_path
    if (row.notes !== null) opt.notes = row.notes
    return asset
  }
}

interface Row {
  id: string; sha256: string; kind: MediaKind; ext: string; mime: string; bytes: number; width: number | null; height: number | null; duration_ms: number | null
  fps: number | null; has_audio: number | null; codec: string | null; poster_sha: string | null; created_at: number; source: AssetRecord['source']
  job_id: string | null; op: string | null; provider: string | null; model_id: string | null; prompt: string | null; negative_prompt: string | null
  params_json: string | null; seed: number | null; cost_usd: number | null; title: string | null; favorite: number; rating: number | null; deleted_at: number | null
  session_id: string | null; workspace_path: string | null; notes: string | null
}
interface EdgeRow { child_id: string; parent_id: string; role: EdgeRole; ord: number }
const toEdge = (r: EdgeRow): AssetEdge => ({ childId: r.child_id, parentId: r.parent_id, role: r.role, ord: r.ord })

interface JobRow {
  id: string; created_at: number; started_at: number | null; finished_at: number | null; updated_at: number; state: JobState; op: JobRecord['op']; model_id: string; provider: JobRecord['provider']
  request_json: string; remote_json: string | null; progress: number | null; message: string | null; error_json: string | null; attempt: number; asset_ids_json: string
  origin: JobRecord['origin']; session_id: string | null; agent_job_id: string | null; estimate_usd: number | null; cost_usd: number | null; cost_source: JobRecord['costSource'] | null
}
function jobParams(j: JobRecord): (string | number | null)[] {
  return [j.id, j.createdAt, j.startedAt ?? null, j.finishedAt ?? null, j.updatedAt, j.state, j.op, j.modelId, j.provider, JSON.stringify(j.request),
    j.remote === undefined ? null : JSON.stringify(j.remote), j.progress ?? null, j.message ?? null, j.error === undefined ? null : JSON.stringify(j.error), j.attempt,
    JSON.stringify(j.assetIds), j.origin, j.sessionId ?? null, j.agentJobId ?? null, j.estimateUsd ?? null, j.costUsd ?? null, j.costSource ?? null]
}
function toJob(r: JobRow): JobRecord {
  const job: JobRecord = { id: r.id, createdAt: r.created_at, updatedAt: r.updated_at, state: r.state, op: r.op, modelId: r.model_id, provider: r.provider,
    request: JSON.parse(r.request_json) as OperationRequest, attempt: r.attempt, assetIds: JSON.parse(r.asset_ids_json) as string[], origin: r.origin }
  const o = job as unknown as Record<string, unknown>
  if (r.started_at !== null) o.startedAt = r.started_at
  if (r.finished_at !== null) o.finishedAt = r.finished_at
  if (r.remote_json !== null) o.remote = JSON.parse(r.remote_json)
  if (r.progress !== null) o.progress = r.progress
  if (r.message !== null) o.message = r.message
  if (r.error_json !== null) o.error = JSON.parse(r.error_json)
  if (r.session_id !== null) o.sessionId = r.session_id
  if (r.agent_job_id !== null) o.agentJobId = r.agent_job_id
  if (r.estimate_usd !== null) o.estimateUsd = r.estimate_usd
  if (r.cost_usd !== null) o.costUsd = r.cost_usd
  if (r.cost_source !== null) o.costSource = r.cost_source
  return job
}

/** Build a safe FTS5 MATCH expression from user text: prefix terms ANDed, no operators. */
export function ftsQuery(text: string): string {
  const terms = text.toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(t => t.length > 0).slice(0, 12)
  return terms.length === 0 ? '""' : terms.map(t => `"${t}"*`).join(' ')
}
