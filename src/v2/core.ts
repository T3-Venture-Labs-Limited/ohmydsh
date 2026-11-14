/** One object holding the v2 state: db, blob store, assets, provider registry and job runner. */
import { join } from 'node:path'
import { BlobStore, resolveStudioRoot } from './assets/blobs.js'
import type { StudioDb } from './assets/db.js'
import { StudioDb as RealDb } from './assets/db.js'
import { lazyDb } from './db-lazy.js'
import { AssetService } from './assets/service.js'
import { JobRunner, type RunnerOptions } from './jobs/runner.js'
import { ProviderRegistry } from './providers/registry.js'

export const DB_FILE = 'studio.db'

export interface StudioCore {
  readonly root: string
  readonly db: StudioDb
  readonly blobs: BlobStore
  readonly assets: AssetService
  readonly registry: ProviderRegistry
  readonly runner: JobRunner
  /** Resolve a provider secret by reference name (set by the host wiring; absent in unit tests). Never returned to clients. */
  keys?: (ref: string) => Promise<string | undefined>
  close(): Promise<void>
}

export function createCore(options: { home?: string; root?: string; runner?: RunnerOptions; dbPath?: string; lazy?: boolean } = {}): StudioCore {
  const root = options.root ?? resolveStudioRoot(options.home)
  const path = options.dbPath ?? join(root, DB_FILE)
  const db: StudioDb = options.lazy === true ? lazyDb(path) : new RealDb(path)
  const blobs = new BlobStore(root)
  const assets = new AssetService(db, blobs)
  const registry = new ProviderRegistry()
  const runner = new JobRunner(db, registry, assets, options.runner)
  return {
    root, db, blobs, assets, registry, runner,
    async close() { await runner.dispose(); db.close() },
  }
}
