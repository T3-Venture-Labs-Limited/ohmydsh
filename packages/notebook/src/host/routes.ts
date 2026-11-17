/**
 * HTTP surface for the sidebar view: one JSON RPC endpoint for actions (the live channel is a Typert stream, see ./push.ts), and a raw file route for images beside a notebook. Every request passes the connection service's
 * Host/Origin and login-cookie gate first and fails closed.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { EditOp, Envelope } from '../core/types.ts'
import { NotebookError } from './document.ts'
import type { NotebookDocument } from './document.ts'
import { annotate, createNotebookEnv, discoverInterpreters, findUv } from './python.ts'
import { resolveNotebookPath, scopeOfSession } from './scope.ts'
import type { NotebookService } from './service.ts'
import type { Settings } from './settings.ts'
import { dirname } from 'node:path'

export const BASE = '/dsh-notebook'

interface ConnectionFace { requestRejection(request: { readonly headers: IncomingMessage['headers'] }): 401 | 403 | undefined }
const connectionOf = (ctx: Context): ConnectionFace | undefined => Reflect.get(ctx, 'connection') as ConnectionFace | undefined

const MAX_BODY = 8 << 20

const ok = <T>(value: T): Envelope<T> => ({ ok: true, value })
const fail = (code: string, message: string): Envelope<never> => ({ ok: false, error: { code, message } })

function json(res: ServerResponse, body: unknown, status = 200): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
  res.end(JSON.stringify(body))
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const buffer = chunk as Buffer
    total += buffer.length
    if (total > MAX_BODY) throw new NotebookError('too-large', 'Request body is too large.')
    chunks.push(buffer)
  }
  const raw = Buffer.concat(chunks).toString('utf8')
  if (raw === '') return {}
  try { return JSON.parse(raw) as unknown } catch { throw new NotebookError('bad-request', 'Malformed JSON.') }
}

/** Mutations additionally need a same-origin browser context (defense in depth beside requestRejection). */
function sameOrigin(req: IncomingMessage): boolean {
  if (req.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = req.headers.origin
  if (origin === undefined) return true
  try { return new URL(origin).host === req.headers.host } catch { return false }
}

const str = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined)

const MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', bmp: 'image/bmp' }

export function registerRoutes(ctx: Context, service: NotebookService, settings: Settings): () => void {
  async function withDoc<T>(payload: Record<string, unknown>, fn: (doc: NotebookDocument, scope: Awaited<ReturnType<typeof scopeOfSession>>) => Promise<T>, options: { create?: boolean } = {}): Promise<T> {
    const sessionId = str(payload.sessionId)
    const path = str(payload.path)
    if (sessionId === undefined || path === undefined) throw new NotebookError('bad-request', 'sessionId and path are required.')
    const scope = await scopeOfSession(ctx, sessionId)
    const doc = await service.open(scope, path, options)
    return await fn(doc, scope)
  }

  async function rpc(method: string, p: Record<string, unknown>): Promise<unknown> {
    switch (method) {
      case 'snapshot':
        return await withDoc(p, async (doc, scope) => doc.snapshot(scope))
      case 'edit':
        return await withDoc(p, async (doc, scope) => {
          doc.assertWritable(scope)
          const ops = Array.isArray(p.ops) ? p.ops as EditOp[] : []
          for (const op of ops) {
            if ('id' in op && typeof op.id === 'string' && doc.isRunning(op.id) && (op.op === 'source' || op.op === 'delete' || op.op === 'type')) throw new NotebookError('cell-running', 'That cell is running; interrupt it first.')
            doc.edit(op, 'user')
          }
          return { rev: doc.rev }
        })
      case 'run':
        return await withDoc(p, async (doc, scope) => {
          doc.assertWritable(scope)
          const ids = Array.isArray(p.cells) ? p.cells.filter((c): c is string => typeof c === 'string') : []
          void doc.run(ids, { timeoutS: 0, stopOnError: p.stopOnError !== false }).catch((error: unknown) => {
            doc.kernel.fail(error instanceof Error ? error.message : String(error))
          })
          return { queued: ids.length }
        })
      case 'interrupt':
        return await withDoc(p, async (doc) => { doc.interrupt(); return {} })
      case 'restart':
        return await withDoc(p, async (doc, scope) => { doc.assertWritable(scope); await doc.restartKernel(); return {} })
      case 'stop':
        return await withDoc(p, async (doc) => { await doc.stopKernel(); return {} })
      case 'save':
        return await withDoc(p, async (doc, scope) => { doc.assertWritable(scope); await doc.save(scope, p.force === true); return {} })
      case 'reload':
        return await withDoc(p, async (doc) => { await doc.reloadFromDisk(); return {} })
      case 'python':
        return await withDoc(p, async (doc, scope) => {
          doc.assertWritable(scope)
          await doc.setPython(typeof p.python === 'string' ? p.python : '', true)
          return {}
        })
      case 'interpreters':
        return await withDoc(p, async (doc, scope) => annotate(await discoverInterpreters({
          workspaceRoot: scope.root,
          notebookDir: dirname(ctx.fs.processPath(doc.target)),
          pinned: doc.chosenPython === '' ? undefined : doc.chosenPython,
          configured: settings.python,
          resolveExecutable: async (name) => { try { return await ctx.subprocess.resolveExecutable(name) } catch { return undefined } },
        })))
      case 'createEnv':
        return await withDoc(p, async (doc, scope) => {
          doc.assertWritable(scope)
          const uv = await findUv(async (name) => { try { return await ctx.subprocess.resolveExecutable(name) } catch { return undefined } })
          if (uv === undefined) throw new NotebookError('no-uv', 'uv was not found. Install uv (https://docs.astral.sh/uv/) and try again.')
          const extras = Array.isArray(p.packages) ? p.packages.filter((x): x is string => typeof x === 'string') : []
          const made = await createNotebookEnv(uv, dirname(ctx.fs.processPath(doc.target)), extras)
          if (!made.ok || made.python === undefined) throw new NotebookError('env-failed', made.message)
          await doc.setPython(made.python, true)
          return { python: made.python, message: made.message }
        })
      default:
        throw new NotebookError('bad-request', `Unknown method "${method}".`)
    }
  }

  async function raw(res: ServerResponse, url: URL): Promise<void> {
    try {
      const scope = await scopeOfSession(ctx, url.searchParams.get('sessionId') ?? '')
      const target = await resolveNotebookPath(ctx, scope, url.searchParams.get('path') ?? '')
      const ext = (url.searchParams.get('path') ?? '').split('.').pop()?.toLowerCase() ?? ''
      const mime = MIME[ext]
      if (mime === undefined) { json(res, fail('bad-type', 'Only images can be served here.'), 415); return }
      const data = await ctx.fs.readBytes(target, undefined, 16 << 20)
      res.writeHead(200, { 'content-type': mime, 'content-length': data.byteLength, 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff', 'content-security-policy': "sandbox; default-src 'none'" })
      res.end(data)
    } catch (error) {
      const e = error instanceof NotebookError ? error : new NotebookError('not-found', 'Cannot read that file.')
      json(res, fail(e.code, e.message), e.code === 'outside-workspace' ? 403 : 404)
    }
  }

  const handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    // Fail closed: without the connection service no request is admitted.
    const connection = connectionOf(ctx)
    const rejection = connection === undefined ? 403 : connection.requestRejection(req)
    if (rejection !== undefined) {
      res.statusCode = rejection
      res.end()
      return
    }
    const url = new URL(req.url ?? '/', 'http://x')
    if (req.method === 'GET') {
      if (url.pathname === `${BASE}/raw`) return await raw(res, url)
      res.statusCode = 404
      res.end()
      return
    }
    if (req.method !== 'POST' || url.pathname !== `${BASE}/rpc`) {
      res.statusCode = 405
      res.setHeader('allow', 'GET, POST')
      res.end()
      return
    }
    if (!sameOrigin(req) || !(req.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) {
      json(res, fail('forbidden', 'Cross-origin or non-JSON request refused.'), 403)
      return
    }
    try {
      const body = await readBody(req)
      const payload = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>
      const method = str(payload.method)
      if (method === undefined) throw new NotebookError('bad-request', 'method is required.')
      json(res, ok(await rpc(method, payload)))
    } catch (error) {
      const e = error instanceof NotebookError ? error : new NotebookError('internal', error instanceof Error ? error.message : String(error))
      json(res, fail(e.code, e.message), e.code === 'internal' ? 500 : e.code === 'outside-workspace' || e.code === 'read-only' || e.code === 'write-denied' ? 403 : 400)
    }
  }

  return ctx.webServer.register({ kind: 'prefix', path: BASE, handler })
}
