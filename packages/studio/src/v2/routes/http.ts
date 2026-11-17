/** Route plumbing: same-origin guard for mutations, JSON bodies, error replies. */
import type { IncomingMessage, ServerResponse } from 'node:http'

export const ROUTE_BASE = '/plugins/dsh-studio/v2'

export function json(res: ServerResponse, status: number, value: unknown): void {
  if (res.headersSent || res.writableEnded || res.destroyed) return
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
  res.end(JSON.stringify(value))
}
export const fail = (res: ServerResponse, status: number, code: string, message?: string): void => json(res, status, { error: code, ...(message === undefined ? {} : { message }) })

/** Mutations must come from this origin: Origin (when present) must match Host, and Sec-Fetch-Site must not be cross-site. */
export function sameOrigin(req: IncomingMessage): boolean {
  const host = req.headers.host
  if (host === undefined) return false
  const site = req.headers['sec-fetch-site']
  if (typeof site === 'string' && site !== 'same-origin' && site !== 'none') return false
  const origin = req.headers.origin
  if (origin === undefined) return true
  try { return new URL(origin).host === host } catch { return false }
}

export async function readJson(req: IncomingMessage, maxBytes = 8 * 1024 * 1024): Promise<unknown> {
  if (!(req.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) throw new HttpError(415, 'json-required')
  const chunks: Buffer[] = []; let total = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string)
    total += buffer.length
    if (total > maxBytes) throw new HttpError(413, 'body-too-large')
    chunks.push(buffer)
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw new HttpError(400, 'invalid-json') }
}

export class HttpError extends Error {
  constructor(readonly status: number, readonly code: string, message?: string) { super(message ?? code) }
}

export const url = (req: IncomingMessage): URL => new URL(req.url ?? '/', 'http://local')
