/**
 * Toolkit catalog: display name + logo URL per toolkit slug, from `GET /api/v3/toolkits` (public data, two pages of
 * 1000). Cached in memory (6 h) and on disk so a restart or an offline moment still has names. Never throws: callers
 * fall back to a prettified slug and a letter avatar.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { prettifySlug, safeLogoUrl } from '../shared/names.ts'

export interface ToolkitInfo { name: string; logo: string | null }
export interface CatalogSource { request(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<unknown> }

const TTL_MS = 6 * 3_600_000
const rec = (v: unknown): Record<string, unknown> => (typeof v === 'object' && v !== null ? v as Record<string, unknown> : {})

/** One catalog page -> entries + the cursor of the next page. */
export function parseToolkitPage(json: unknown): { entries: [string, ToolkitInfo][]; next: string | null } {
  const root = rec(json)
  const entries: [string, ToolkitInfo][] = []
  for (const raw of Array.isArray(root['items']) ? root['items'] : []) {
    const item = rec(raw)
    const slug = typeof item['slug'] === 'string' ? item['slug'] : ''
    if (slug === '') continue
    const name = typeof item['name'] === 'string' && item['name'].trim() !== '' ? item['name'].trim().slice(0, 80) : prettifySlug(slug)
    entries.push([slug, { name, logo: safeLogoUrl(rec(item['meta'])['logo']) }])
  }
  return { entries, next: typeof root['next_cursor'] === 'string' && root['next_cursor'] !== '' ? root['next_cursor'] : null }
}

export class ToolkitCatalog {
  private map = new Map<string, ToolkitInfo>()
  private at = 0
  private loaded = false
  private inflight: Promise<void> | undefined

  constructor(private readonly source: CatalogSource, private readonly file?: string, private readonly now: () => number = Date.now, private readonly waitMs = 4000) {}

  /** The catalog as known right now; waits at most `waitMs` for a refresh and keeps refreshing in the background. */
  async get(): Promise<ReadonlyMap<string, ToolkitInfo>> {
    if (!this.loaded) await this.readDisk()
    if (this.now() - this.at > TTL_MS) {
      this.inflight ??= this.refresh().finally(() => { this.inflight = undefined })
      await Promise.race([this.inflight, new Promise<void>((resolve) => setTimeout(resolve, this.waitMs).unref())])
    }
    return this.map
  }

  private async readDisk(): Promise<void> {
    this.loaded = true
    if (this.file === undefined) return
    try {
      const json = rec(JSON.parse(await readFile(this.file, 'utf8')))
      const items = rec(json['items'])
      for (const [slug, v] of Object.entries(items)) {
        const o = rec(v)
        if (typeof o['name'] === 'string') this.map.set(slug, { name: o['name'], logo: safeLogoUrl(o['logo']) })
      }
      if (typeof json['at'] === 'number') this.at = json['at']
    } catch { /* no cache yet */ }
  }

  private async refresh(): Promise<void> {
    try {
      const next = new Map<string, ToolkitInfo>()
      let cursor: string | null = null
      for (let page = 0; page < 6; page++) {
        const path: string = `/api/v3/toolkits?limit=1000${cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`}`
        const parsed = parseToolkitPage(await this.source.request('GET', path, undefined, AbortSignal.timeout(15_000)))
        for (const [slug, info] of parsed.entries) next.set(slug, info)
        cursor = parsed.next
        if (cursor === null) break
      }
      if (next.size === 0) return
      this.map = next
      this.at = this.now()
      await this.writeDisk()
    } catch { /* keep what we have; retry on the next get() once the TTL check allows it */ this.at = Math.max(this.at, this.now() - TTL_MS + 60_000) }
  }

  private async writeDisk(): Promise<void> {
    if (this.file === undefined) return
    try {
      await mkdir(dirname(this.file), { recursive: true })
      const tmp = `${this.file}.tmp`
      await writeFile(tmp, JSON.stringify({ at: this.at, items: Object.fromEntries(this.map) }), 'utf8')
      await rename(tmp, this.file)
    } catch { /* cache is optional */ }
  }
}
