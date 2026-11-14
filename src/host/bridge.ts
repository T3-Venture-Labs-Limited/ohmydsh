/**
 * Unix-socket NDJSON JSON-RPC 2.0 server for the HUD (protocol trimmed from dsh-quorfloat's `quorfloat/1`, MIT).
 * One connection = one HUD. Same-uid trust: socket mode 0600 inside the user's runtime dir.
 *
 * TRUST BOUNDARY (HUD-1): any same-uid process can connect, including a process the agent runs inside DSH's own
 * sandbox (bwrap/Landlock do not scope unix sockets). So the bridge never hands out credentials (`web/url` is the
 * plain URL) and refuses to prompt, create or re-model sessions that run in danger-full-access unless the operator
 * set `allowDangerousSessions`. Listing sessions and attaching (reading transcripts) stay available: a sandboxed
 * process can already read the session logs from disk.
 */
import { chmodSync, lstatSync, unlinkSync } from 'node:fs'
import { createServer, connect, type Server, type Socket } from 'node:net'
import { randomUUID } from 'node:crypto'
import { GuardError, type Harness, type ModelChoice } from './harness.ts'
import { Transcript, type Update } from './transcript.ts'

export const PROTOCOL = 'dsh-hud/1'
export const MAX_FRAME = 1024 * 1024
export const ErrorCode = { Parse: -32700, Request: -32600, Method: -32601, Params: -32602, Internal: -32603, Unavailable: -32004, Forbidden: -32003 } as const
export const MAX_CONNECTIONS = 8

type Json = Record<string, unknown>
class RpcError extends Error { constructor(readonly code: number, message: string) { super(message) } }

/** Turn a trust-boundary refusal into a Forbidden RPC error. */
function guard(check: () => void): void {
  try { check() } catch (error) {
    if (error instanceof GuardError) throw new RpcError(ErrorCode.Forbidden, error.message)
    throw error
  }
}

interface Logger { info(m: string): void; warn(m: string): void; debug(m: string): void }

const text = (v: unknown, name: string): string => {
  if (typeof v !== 'string' || v === '') throw new RpcError(ErrorCode.Params, `${name} must be a non-empty string`)
  return v
}

class Connection {
  attached: { sessionId: string; transcript: Transcript; stop: () => void } | undefined
  constructor(readonly socket: Socket) {}
  send(message: Json): void {
    if (this.socket.destroyed) return
    const line = JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n'
    if (line.length > MAX_FRAME) return
    this.socket.write(line)
  }
  notify(method: string, params: Json): void { this.send({ method, params }) }
}

export interface BridgeInfo { home: string; socket: string; workspace: () => string; model: () => string }

export class Bridge {
  private server: Server | undefined
  private readonly connections = new Set<Connection>()

  constructor(private readonly harness: Harness, private readonly log: Logger, private readonly info: BridgeInfo, private readonly version: string) {}

  /** Listens on `path`. A live socket owned by another process is left alone (returns false); a stale file is replaced. */
  async listen(path: string): Promise<boolean> {
    let existing: ReturnType<typeof lstatSync> | undefined
    try { existing = lstatSync(path) } catch { existing = undefined }
    if (existing !== undefined) {
      // HUD-4: only ever replace a stale socket, never a regular file or a symlink that happens to sit at the path.
      if (!existing.isSocket()) { this.log.warn(`dsh-hud: ${path} exists and is not a socket; refusing to replace it`); return false }
      const alive = await new Promise<boolean>((resolve) => {
        const probe = connect(path)
        probe.once('connect', () => { probe.destroy(); resolve(true) })
        probe.once('error', () => { resolve(false) })
      })
      if (alive) { this.log.warn(`dsh-hud: ${path} is served by another process; not binding`); return false }
      try { unlinkSync(path) } catch { /* raced */ }
    }
    return await new Promise<boolean>((resolve) => {
      const server = createServer((socket) => { this.accept(socket) })
      server.once('error', (error) => { this.log.warn(`dsh-hud: cannot listen on ${path}: ${error.message}`); resolve(false) })
      server.listen(path, () => {
        try { chmodSync(path, 0o600) } catch { /* best effort; the runtime dir is 0700 */ }
        this.server = server
        this.log.info(`dsh-hud: listening on ${path}`)
        resolve(true)
      })
    })
  }

  close(): void {
    for (const c of this.connections) { c.attached?.stop(); c.socket.destroy() }
    this.connections.clear()
    this.server?.close()
    this.server = undefined
  }

  /** Tell every attached HUD the session list changed (they re-request `sessions/list`). */
  sessionsChanged(): void { for (const c of this.connections) c.notify('sessions/changed', { reason: 'refresh' }) }

  private accept(socket: Socket): void {
    if (this.connections.size >= MAX_CONNECTIONS) { socket.destroy(); return }
    const connection = new Connection(socket)
    this.connections.add(connection)
    let buffer = ''
    socket.setEncoding('utf8')
    socket.on('data', (chunk: string) => {
      buffer += chunk
      let newline: number
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1)
        if (line.trim() !== '') void this.dispatch(connection, line)
      }
      if (buffer.length > MAX_FRAME) { buffer = ''; connection.send({ id: null, error: { code: ErrorCode.Request, message: 'frame too large' } }) }
    })
    const drop = (): void => { connection.attached?.stop(); connection.attached = undefined; this.connections.delete(connection) }
    socket.on('close', drop)
    socket.on('error', drop)
  }

  private async dispatch(connection: Connection, line: string): Promise<void> {
    let request: Json
    try { request = JSON.parse(line) as Json } catch { connection.send({ id: null, error: { code: ErrorCode.Parse, message: 'parse error' } }); return }
    const id = request['id']
    const method = request['method']
    if (typeof method !== 'string') { if (id !== undefined) connection.send({ id, error: { code: ErrorCode.Request, message: 'invalid request' } }); return }
    const params = (typeof request['params'] === 'object' && request['params'] !== null ? request['params'] : {}) as Json
    try {
      const result = await this.handle(connection, method, params)
      if (id !== undefined) connection.send({ id, result })
    } catch (error) {
      if (id === undefined) return
      const rpc = error instanceof RpcError ? error : new RpcError(ErrorCode.Internal, error instanceof Error ? error.message : String(error))
      connection.send({ id, error: { code: rpc.code, message: rpc.message } })
    }
  }

  private async handle(c: Connection, method: string, p: Json): Promise<unknown> {
    switch (method) {
      case 'hello':
        return { protocol: PROTOCOL, product: 'dsh-hud-host', version: this.version, home: this.info.home, socket: this.info.socket, workspace: this.info.workspace(), model: this.info.model(), harness: this.harness.describe() }
      case 'ping': return { pong: Date.now() }
      case 'workspaces/list': return { items: this.harness.workspaces() }
      case 'workspace/default': { const w = await this.harness.hudWorkspace(); return { items: w === undefined ? [] : [w] } }
      case 'sessions/list': return { items: await this.harness.sessions() }
      case 'session/create': {
        guard(() => this.harness.assertMayCreate())
        const created = await this.harness.createSession(typeof p['workspaceId'] === 'string' ? p['workspaceId'] : undefined)
        return created
      }
      case 'session/attach': return this.attach(c, text(p['sessionId'], 'sessionId'))
      case 'session/detach': c.attached?.stop(); c.attached = undefined; return { ok: true }
      case 'session/prompt': {
        const sessionId = text(p['sessionId'], 'sessionId'); const body = text(p['text'], 'text')
        // The id is the Harness idempotency key: unique per attempt and across processes.
        guard(() => this.harness.assertMayDrive(sessionId))
        const requestId = typeof p['requestId'] === 'string' && p['requestId'] !== '' ? p['requestId'] : `${sessionId}:hud-${randomUUID()}`
        await this.harness.prompt(sessionId, requestId, body)
        return { accepted: true, requestId }
      }
      case 'session/cancel': this.harness.cancel(text(p['sessionId'], 'sessionId')); return { accepted: true }
      case 'session/options': return await this.harness.options(typeof p['sessionId'] === 'string' ? p['sessionId'] : undefined)
      case 'session/select': {
        const choice: ModelChoice = { provider: text(p['provider'], 'provider'), model: text(p['model'], 'model'), ...(typeof p['reasoningEffort'] === 'string' && p['reasoningEffort'] !== '' ? { reasoningEffort: p['reasoningEffort'] } : {}) }
        const target = text(p['sessionId'], 'sessionId')
        guard(() => this.harness.assertMayDrive(target))
        this.harness.selectModel(target, choice)
        return { selected: choice }
      }
      case 'web/url': {
        const url = this.harness.webUrl(typeof p['sessionId'] === 'string' ? p['sessionId'] : undefined)
        if (url === undefined) throw new RpcError(ErrorCode.Unavailable, 'the web app URL is not available')
        return { url }
      }
      default: throw new RpcError(ErrorCode.Method, `unknown method ${method}`)
    }
  }

  private attach(c: Connection, sessionId: string): unknown {
    c.attached?.stop()
    const transcript = new Transcript()
    let snapshotted = false
    const emit = (updates: Update[]): void => {
      for (const u of updates) {
        if (u.type === 'entry') c.notify('session/entry', { sessionId, entry: u.entry })
        else if (u.type === 'status') c.notify('session/status', { sessionId, running: u.running })
        else if (u.type === 'title') c.notify('session/title', { sessionId, title: u.title })
        else if (u.type === 'approval') c.notify('session/approval', { sessionId, pending: u.pending })
        else c.notify('session/stream', { sessionId, text: '' })
      }
    }
    const stop = this.harness.follow(sessionId, (frame) => {
      if (frame.type === 'snapshot') {
        transcript.foldRecords(frame.records, frame.cursor)
        snapshotted = true
        c.notify('session/snapshot', { sessionId, entries: transcript.entries, title: transcript.title, running: transcript.running, approval: transcript.approval, cursor: transcript.cursor })
      } else if (frame.type === 'event') {
        if (snapshotted) emit(transcript.foldEvent(frame.seq, frame.eventType, frame.data))
      } else {
        const live = transcript.foldStream(frame.frame)
        if (live !== undefined) c.notify('session/stream', { sessionId, text: live })
      }
    }, (error) => {
      this.log.warn(`dsh-hud: follow ended: ${error instanceof Error ? error.message : String(error)}`)
      c.notify('session/resync', { sessionId })
    })
    c.attached = { sessionId, transcript, stop }
    return { sessionId }
  }
}
