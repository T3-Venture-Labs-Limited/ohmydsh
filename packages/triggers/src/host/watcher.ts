/**
 * File source: a recursive `fs.watch` on the automation's directory (Node ≥ 22 picks up subdirectories created later),
 * plus a bounded catch-up scan on start and every 5 minutes. A file whose NAME matches the pattern fires when
 *   (a) it has been quiet for `settleMs` (per-file debounce),
 *   (b) the optional `requireSibling` JSON condition holds (re-checked when the sibling changes),
 *   (c) it is not already known (baseline taken when the automation is created / its path or pattern changes, or fired).
 * The file content is never read; only metadata (and the small sibling JSON) goes into the event.
 */
import { watch, type FSWatcher } from 'node:fs'
import { readdir, readFile, realpath, stat } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import type { FileSource } from '../shared/types.ts'
import type { FileInfo } from './prompt.ts'
import { errorText, globToRegExp } from './util.ts'

export const SCAN_DEPTH = 4
export const SCAN_MAX_FILES = 5000
export const CATCH_UP_MS = 5 * 60_000
export const SIBLING_MAX_BYTES = 256 * 1024

export interface FileMatch { file: FileInfo; real: string; sibling?: unknown }

export interface WatcherDeps {
  isKnown: (real: string) => boolean
  markKnown: (reals: readonly string[]) => void
  /** Whether a baseline exists for this exact root + pattern. */
  hasBaseline: (key: string) => boolean
  markBaseline: (key: string) => void
  /** Deliver one settled match. Resolve `true` when the file is consumed (never fires again), `false` to retry later. */
  onMatch: (match: FileMatch) => Promise<boolean>
  log: { info(m: string): void; warn(m: string): void }
  /** Overridable for tests. */
  catchUpMs?: number
}

export const baselineKey = (source: Pick<FileSource, 'path' | 'pattern'>): string => `${source.path}\n${source.pattern}`

/** Bounded recursive listing of files under `root` (depth ≤ SCAN_DEPTH, ≤ SCAN_MAX_FILES entries visited). */
export async function scanFiles(root: string, accept: (name: string) => boolean, depth = SCAN_DEPTH, limit = SCAN_MAX_FILES): Promise<string[]> {
  const out: string[] = []
  let visited = 0
  const walk = async (dir: string, level: number): Promise<void> => {
    if (visited >= limit) return
    let entries: import('node:fs').Dirent[]
    try { entries = await readdir(dir, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      if (++visited > limit) return
      const full = join(dir, entry.name)
      if (entry.isDirectory()) { if (level < depth && !entry.name.startsWith('.')) await walk(full, level + 1) } else if (entry.isFile() && accept(entry.name)) out.push(full)
    }
  }
  await walk(root, 0)
  return out
}

export async function readSibling(dir: string, file: string): Promise<unknown> {
  const path = join(dir, file)
  const info = await stat(path)
  if (!info.isFile() || info.size > SIBLING_MAX_BYTES) return undefined
  return JSON.parse(await readFile(path, 'utf8')) as unknown
}

export function siblingHolds(sibling: unknown, field: string, equals: string): boolean {
  let cur: unknown = sibling
  for (const part of field.split('.')) cur = typeof cur === 'object' && cur !== null ? (cur as Record<string, unknown>)[part] : undefined
  if (cur === undefined || cur === null) return false
  return (typeof cur === 'string' ? cur : JSON.stringify(cur)) === equals
}

export class FileWatcher {
  private watcher: FSWatcher | undefined
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly busy = new Set<string>()
  private interval: ReturnType<typeof setInterval> | undefined
  private readonly matches: RegExp
  private stopped = false
  private ready: Promise<void> = Promise.resolve()

  constructor(readonly automationId: string, readonly source: FileSource, private readonly deps: WatcherDeps) {
    this.matches = globToRegExp(source.pattern)
  }

  get root(): string { return this.source.path }
  get watching(): boolean { return this.watcher !== undefined }

  /** Baseline (first time for this path+pattern), then watch + catch-up scan. */
  start(): Promise<void> {
    this.ready = (async () => {
      const key = baselineKey(this.source)
      if (!this.deps.hasBaseline(key)) {
        await this.baseline()
        this.deps.markBaseline(key)
      }
      if (this.stopped) return
      this.attach()
      await this.catchUp()
    })().catch((error: unknown) => { this.deps.log.warn(`triggers: file watch for ${this.automationId} failed to start: ${errorText(error)}`) })
    this.interval = setInterval(() => { this.attach(); void this.catchUp() }, this.deps.catchUpMs ?? CATCH_UP_MS)
    this.interval.unref?.()
    return this.ready
  }

  stop(): void {
    this.stopped = true
    this.watcher?.close(); this.watcher = undefined
    if (this.interval !== undefined) clearInterval(this.interval)
    for (const t of this.timers.values()) clearTimeout(t)
    this.timers.clear()
  }

  /** Mark every current match as known so the back catalogue never fires. */
  async baseline(): Promise<number> {
    const files = await scanFiles(this.root, (n) => this.matches.test(n))
    const reals = await Promise.all(files.map(async (f) => { try { return await realpath(f) } catch { return f } }))
    this.deps.markKnown(reals)
    return reals.length
  }

  /** Find matches missed while not watching (DSH down, watcher error) and schedule them. */
  async catchUp(): Promise<void> {
    if (this.stopped) return
    const files = await scanFiles(this.root, (n) => this.matches.test(n))
    for (const f of files) {
      if (this.timers.has(f)) continue
      let real = f
      try { real = await realpath(f) } catch { continue }
      if (!this.deps.isKnown(real)) this.schedule(f)
    }
  }

  private attach(): void {
    if (this.watcher !== undefined || this.stopped) return
    try {
      const w = watch(this.root, { recursive: true, persistent: false }, (_type, name) => { if (name !== null) this.onFsEvent(join(this.root, name.toString())) })
      w.on('error', (error) => {
        this.deps.log.warn(`triggers: file watch for ${this.automationId} stopped: ${errorText(error)} (retrying with the next catch-up scan)`)
        w.close(); if (this.watcher === w) this.watcher = undefined
      })
      this.watcher = w
    } catch (error) {
      const code = (error as { code?: string }).code
      if (code !== 'ENOENT') this.deps.log.warn(`triggers: cannot watch ${this.automationId}: ${errorText(error)}`)
    }
  }

  private onFsEvent(full: string): void {
    const name = basename(full)
    if (this.matches.test(name)) this.schedule(full)
    const sibling = this.source.requireSibling?.file
    if (sibling !== undefined && name === sibling) void this.recheckDir(dirname(full))
    // A new directory may have received files before the kernel watch on it was added: scan it once.
    void stat(full).then((s) => { if (s.isDirectory()) void this.scanNewDir(full) }, () => {})
  }

  private async scanNewDir(dir: string): Promise<void> {
    for (const f of await scanFiles(dir, (n) => this.matches.test(n), 2, 500)) if (!this.timers.has(f)) this.schedule(f)
  }

  private async recheckDir(dir: string): Promise<void> {
    let names: string[]
    try { names = await readdir(dir) } catch { return }
    for (const n of names) if (this.matches.test(n)) this.schedule(join(dir, n))
  }

  /** Per-file debounce: (re)start the settle timer. */
  schedule(full: string, delay = this.source.settleMs): void {
    if (this.stopped) return
    const prior = this.timers.get(full)
    if (prior !== undefined) clearTimeout(prior)
    const t = setTimeout(() => { this.timers.delete(full); void this.check(full) }, Math.max(0, delay))
    t.unref?.()
    this.timers.set(full, t)
  }

  private async check(full: string): Promise<void> {
    if (this.stopped || this.busy.has(full)) return
    this.busy.add(full)
    try {
      let info: import('node:fs').Stats
      try { info = await stat(full) } catch { return }
      if (!info.isFile()) return
      // Written to recently (e.g. found by a scan while still being written): wait for quiet.
      const age = Date.now() - info.mtimeMs
      if (age < this.source.settleMs) { this.schedule(full, this.source.settleMs - age + 50); return }
      const real = await realpath(full).catch(() => full)
      if (this.deps.isKnown(real)) return
      const dir = dirname(full)
      let sibling: unknown
      const req = this.source.requireSibling
      if (req !== undefined) {
        try { sibling = await readSibling(dir, req.file) } catch { return } // missing / invalid: re-checked when it changes
        if (!siblingHolds(sibling, req.field, req.equals)) return
      }
      const file: FileInfo = { path: full, name: basename(full), dirname: basename(dir), dir, size: info.size, mtime: info.mtimeMs }
      const consumed = await this.deps.onMatch({ file, real, ...(sibling === undefined ? {} : { sibling }) })
      if (consumed) this.deps.markKnown([real])
    } catch (error) {
      this.deps.log.warn(`triggers: file check failed for ${this.automationId}: ${errorText(error)}`)
    } finally { this.busy.delete(full) }
  }

  /** Test helper: resolves after start-up work. */
  whenReady(): Promise<void> { return this.ready }
}
