import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { ICON_PATHS } from '../shared/index-html.ts'

/** The package root (the folder holding assets/ and package.json), whether running from lib/ or from src/ in tests. */
export function packageRoot(): string {
  let dir = import.meta.dirname
  for (let i = 0; i < 5; i++) { if (existsSync(resolve(dir, 'assets', 'mark.svg'))) return dir; dir = dirname(dir) }
  return resolve(import.meta.dirname, '..')
}
const ASSETS = resolve(packageRoot(), 'assets')

const TYPES: Record<string, string> = { '.svg': 'image/svg+xml', '.png': 'image/png' }

/** Public, secret-free static icons at the stock paths (exact routes win over the shell's fallback seat). */
export function iconHandler(path: (typeof ICON_PATHS)[number]): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const file = resolve(ASSETS, path.slice(1))
  const type = TYPES[path.slice(path.lastIndexOf('.'))] ?? 'application/octet-stream'
  let cached: Promise<{ body: Buffer; etag: string }> | undefined
  const load = (): Promise<{ body: Buffer; etag: string }> => (cached ??= readFile(file).then((body) => ({ body, etag: `W/"${createHash('sha1').update(body).digest('base64url')}"` })).catch((error: unknown) => { cached = undefined; throw error }))
  return async (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, { allow: 'GET, HEAD' }); res.end(); return }
    try {
      const { body, etag } = await load()
      const headers = { 'content-type': type, 'cache-control': 'no-cache', etag, 'x-content-type-options': 'nosniff' }
      if (req.headers['if-none-match'] === etag) { res.writeHead(304, headers); res.end(); return }
      res.writeHead(200, headers)
      res.end(req.method === 'HEAD' ? undefined : body)
    } catch {
      res.writeHead(404); res.end()
    }
  }
}
