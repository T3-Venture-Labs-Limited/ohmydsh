import { randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { basename, dirname, join } from 'node:path'
import type { IncomingMessage } from 'node:http'

/** What the phone shared, as stored for the UI to turn into a composer draft. */
export interface ShareRecord {
  readonly id: string
  readonly at: number
  readonly title: string
  readonly text: string
  readonly url: string
  /** Absolute paths of saved files, inside the share directory. */
  readonly files: readonly { readonly name: string; readonly path: string; readonly size: number; readonly type: string }[]
  /** Workspace directory the shared files were saved under (empty = next to the record). */
  readonly cwd: string
}

export class ShareError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
  }
}

const MAX_FIELD = 20_000
const MAX_FILES = 12
const ID = /^[a-f0-9]{24}$/

/** A safe single path segment: no separators, no leading dots, bounded length. */
export function safeName(raw: string, fallback: string): string {
  const base = basename(raw.replaceAll('\\', '/')).replace(/[^\p{L}\p{N}._ ()+-]/gu, '_').replace(/^\.+/, '').trim()
  return (base === '' ? fallback : base).slice(0, 120)
}

export const isShareId = (value: string): boolean => ID.test(value)

/**
 * Parse one share-target POST (multipart/form-data) and save its files under `<dir>/<id>/`.
 * The body is streamed through undici's multipart parser with a hard byte cap, so an oversized upload is cut off
 * instead of buffered.
 */
export async function receiveShare(req: IncomingMessage, options: { dir: string; cwd: string; maxBytes: number; filesDir?: string }): Promise<ShareRecord> {
  const type = String(req.headers['content-type'] ?? '')
  if (!/^(multipart\/form-data|application\/x-www-form-urlencoded)/i.test(type)) throw new ShareError(415, 'unsupported content type')
  const declared = Number(req.headers['content-length'] ?? '0')
  if (Number.isFinite(declared) && declared > options.maxBytes) throw new ShareError(413, 'share too large')

  let received = 0
  const capped = Readable.toWeb(req.pipe(new (await import('node:stream')).Transform({
    transform(chunk: Buffer, _enc, cb) {
      received += chunk.byteLength
      if (received > options.maxBytes) cb(new ShareError(413, 'share too large'))
      else cb(null, chunk)
    },
  }))) as ReadableStream<Uint8Array>
  const request = new Request('http://dsh.internal/share', {
    method: 'POST',
    headers: { 'content-type': type },
    body: capped,
    duplex: 'half',
  } as RequestInit & { duplex: 'half' })
  let form: FormData
  try {
    form = await request.formData()
  } catch (error) {
    if (error instanceof ShareError) throw error
    if (received > options.maxBytes) throw new ShareError(413, 'share too large')
    throw new ShareError(400, 'invalid form data')
  }

  const field = (name: string): string => {
    const value = form.get(name)
    return typeof value === 'string' ? value.slice(0, MAX_FIELD) : ''
  }
  const id = randomBytes(12).toString('hex')
  // Files go inside the target workspace when one is configured (so a sandboxed agent can read them); the small JSON
  // record always stays in the plugin's own data directory.
  const folder = join(options.filesDir ?? options.dir, id)
  const files: ShareRecord['files'][number][] = []
  const entries = form.getAll('files').filter((value): value is File => typeof value !== 'string')
  if (entries.length > MAX_FILES) throw new ShareError(413, 'too many files')
  if (entries.length > 0) await mkdir(folder, { recursive: true, mode: 0o700 })
  const used = new Set<string>()
  for (const [index, file] of entries.entries()) {
    let name = safeName(file.name, `shared-${index + 1}`)
    while (used.has(name)) name = `${index + 1}-${name}`
    used.add(name)
    const path = join(folder, name)
    const tmp = `${path}.part`
    await writeFile(tmp, Buffer.from(await file.arrayBuffer()), { mode: 0o600 })
    await rename(tmp, path)
    files.push({ name, path, size: file.size, type: file.type })
  }
  const record: ShareRecord = { id, at: Date.now(), title: field('title'), text: field('text'), url: field('url'), files, cwd: options.cwd }
  if (record.title === '' && record.text === '' && record.url === '' && files.length === 0) throw new ShareError(400, 'nothing was shared')
  await mkdir(options.dir, { recursive: true, mode: 0o700 })
  await writeFile(join(options.dir, `${id}.json`), JSON.stringify(record), { mode: 0o600 })
  return record
}

export async function readShare(dir: string, id: string): Promise<ShareRecord | undefined> {
  if (!ID.test(id)) return undefined
  try {
    return JSON.parse(await readFile(join(dir, `${id}.json`), 'utf8')) as ShareRecord
  } catch {
    return undefined
  }
}

/** Remove shares older than `maxAgeMs` (their record and folder). */
export async function pruneShares(dir: string, ids: readonly string[], maxAgeMs: number): Promise<void> {
  for (const id of ids) {
    const record = await readShare(dir, id)
    if (record === undefined || Date.now() - record.at < maxAgeMs) continue
    await rm(join(dir, id), { recursive: true, force: true })
    for (const file of record.files) await rm(dirname(file.path), { recursive: true, force: true }).catch(() => {})
    await rm(join(dir, `${id}.json`), { force: true })
  }
}
