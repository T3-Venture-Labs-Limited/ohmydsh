/**
 * Client-side mirror of one notebook document. The host pushes every change as an SSE event; this store applies
 * them to a local copy and notifies React. Local edits are sent to the host (which broadcasts them back), so the
 * UI, the agent and the file all follow the same sequence of events. The push channel is a Typert stream on DSH's one
 * multiplexed WebSocket (never an HTTP stream: the browser allows only 6 per host), open only while the page is visible;
 * it starts with a full snapshot, so a reopen after a hidden period resyncs by itself. While it cannot be opened, a slow
 * (>= 15 s) snapshot poll keeps the view fresh.
 */
import type { EditOp, Envelope, NotebookEvent, WireCell, WireNotebook, InterpreterOption } from '../core/types.ts'
import { subscribePush } from '../kit/push/client.ts'
import type { PushEnv } from '../kit/push/client.ts'

const BASE = '/dsh-notebook'

export type Connection = 'connecting' | 'open' | 'reconnecting' | 'closed'
export interface StoreState {
  nb: WireNotebook | null
  connection: Connection
  error: { code: string; message: string } | null
  /** Cell ids the agent touched recently, for a brief highlight. */
  agentTouched: Record<string, number>
}

export async function rpc<T>(method: string, args: Record<string, unknown>): Promise<Envelope<T>> {
  try {
    const response = await fetch(`${BASE}/rpc`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ method, ...args }) })
    try {
      return (await response.json()) as Envelope<T>
    } catch {
      return { ok: false, error: { code: 'network', message: `The server answered with HTTP ${response.status}.` } }
    }
  } catch {
    return { ok: false, error: { code: 'network', message: 'Could not reach the dsh server.' } }
  }
}

/** Opens the Host stream for one notebook (items are NotebookEvents); it must end when the signal aborts. */
export type OpenNotebookStream = (sessionId: string, path: string, signal: AbortSignal) => AsyncIterable<unknown>
export const FALLBACK_POLL_MS = 15_000
/**
 * The page-wide opener, set once by the client entry. The lazy view chunk carries its own copy of this module (chunks are
 * self-contained), so the opener lives on globalThis rather than in a module variable.
 */
const SHARED = '__dshNotebookStream_v1'
const shared = (): { open?: OpenNotebookStream | undefined } => ((globalThis as Record<string, unknown>)[SHARED] ??= {}) as { open?: OpenNotebookStream | undefined }
export function configureNotebookStream(open: OpenNotebookStream | undefined): void { shared().open = open }

export class NotebookStore {
  private state: StoreState = { nb: null, connection: 'connecting', error: null, agentTouched: {} }
  private readonly listeners = new Set<() => void>()
  private unsubscribe: (() => void) | undefined
  private closed = false

  constructor(readonly sessionId: string, readonly path: string, private readonly open: OpenNotebookStream | undefined = shared().open, private readonly push: PushEnv = {}) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getSnapshot = (): StoreState => this.state

  private set(patch: Partial<StoreState>): void {
    this.state = { ...this.state, ...patch }
    for (const listener of this.listeners) listener()
  }

  /** Open the push channel (idempotent). The server sends a full snapshot first, then incremental events. */
  connect(): void {
    if (this.unsubscribe !== undefined || this.closed) return
    const open = this.open
    if (open === undefined) { void this.diagnose(); return }
    this.unsubscribe = subscribePush<unknown>({
      // One logical stream per open notebook; every one shares the page's single WebSocket, so none costs an HTTP connection.
      id: `dsh-notebook:${this.sessionId}:${this.path}`,
      replay: false,
      open: (signal) => open(this.sessionId, this.path, signal),
      onOpen: () => { this.set({ connection: 'open', error: null }) },
      onClose: () => { if (!this.closed && this.state.connection === 'open') this.set({ connection: 'reconnecting' }) },
      // A refused stream (permission, missing file) is final; anything else retries. Probe so the UI can say why.
      onError: async () => { return await this.diagnose() },
      poll: async () => { await this.diagnose() },
      pollMs: FALLBACK_POLL_MS,
    }, (event) => { try { this.apply(event as NotebookEvent) } catch { /* ignore a malformed frame */ } }, this.push)
  }

  /** Probe why the stream is not delivering (permission, missing file) with a normal request. Returns false when final. */
  private async diagnose(): Promise<boolean> {
    const result = await rpc<WireNotebook>('snapshot', { sessionId: this.sessionId, path: this.path })
    if (this.closed) return false
    // A session that is not live yet (right after a host restart) becomes live again on its own: keep trying
    // with backoff instead of giving up. Anything else (outside the workspace, not a notebook, ...) is final.
    const transient = !result.ok && (result.error.code === 'no-session' || result.error.code === 'network')
    if (!result.ok) {
      this.set({ connection: transient ? 'reconnecting' : 'closed', error: result.error })
      return transient
    }
    this.set({ nb: result.value })
    return true
  }

  close(): void {
    this.closed = true
    this.unsubscribe?.()
    this.unsubscribe = undefined
  }

  private touchAgent(ids: string[], by: string | undefined): void {
    if (by !== 'agent' || ids.length === 0) return
    const now = Date.now()
    const next = { ...this.state.agentTouched }
    for (const id of ids) next[id] = now
    this.state = { ...this.state, agentTouched: next }
    setTimeout(() => {
      const cur = { ...this.state.agentTouched }
      let changed = false
      for (const id of ids) if (cur[id] === now) { delete cur[id]; changed = true }
      if (changed) this.set({ agentTouched: cur })
    }, 2500)
  }

  private apply(event: NotebookEvent): void {
    const nb = this.state.nb
    if (event.t === 'snap') {
      this.set({ nb: event.nb, error: null })
      return
    }
    if (nb === null) return
    switch (event.t) {
      case 'cell': {
        const cells = [...nb.cells]
        const at = cells.findIndex((c) => c.id === event.cell.id)
        if (at >= 0) {
          const keep = cells[at]?.run
          const { run: _drop, ...fresh } = event.cell
          cells[at] = { ...fresh, ...keep === undefined ? {} : { run: keep } }
        }
        else cells.splice(Math.min(event.index, cells.length), 0, event.cell)
        this.touchAgent([event.cell.id], event.by)
        this.set({ nb: { ...nb, cells, rev: event.rev, dirty: true } })
        return
      }
      case 'order': {
        const byId = new Map(nb.cells.map((c) => [c.id, c]))
        const cells = event.ids.map((id) => byId.get(id)).filter((c): c is WireCell => c !== undefined)
        // An id we have not seen yet will arrive in its own `cell` event; keep order of the rest.
        this.set({ nb: { ...nb, cells, rev: event.rev, dirty: true } })
        return
      }
      case 'out': {
        const cells = nb.cells.map((cell) => {
          if (cell.id !== event.id) return cell
          const outputs = [...cell.outputs]
          const last = outputs.at(-1)
          if (event.append === true && last !== undefined && last.output_type === 'stream' && last.name === event.output.name) {
            outputs[outputs.length - 1] = { ...last, text: String(last.text ?? '') + String(event.output.text ?? '') }
          } else if (event.output.output_type === undefined && event.append === false) {
            outputs.push({ output_type: 'stream', name: event.output.name, text: event.output.text })
          } else outputs.push(event.output)
          return { ...cell, outputs }
        })
        this.set({ nb: { ...nb, cells, rev: event.rev } })
        return
      }
      case 'clear':
        this.set({ nb: { ...nb, rev: event.rev, cells: nb.cells.map((c) => (c.id === event.id ? { ...c, outputs: [], execution_count: null } : c)) } })
        return
      case 'run': {
        this.set({
          nb: {
            ...nb,
            rev: event.rev,
            cells: nb.cells.map((c) => {
              if (c.id !== event.id) return c
              const { run: _old, ...rest } = c
              return { ...rest, ...event.run === null ? {} : { run: event.run }, ...event.execution_count === undefined ? {} : { execution_count: event.execution_count } }
            }),
          },
        })
        return
      }
      case 'kernel':
        this.set({ nb: { ...nb, kernel: event.kernel } })
        return
      case 'meta':
        this.set({ nb: { ...nb, metadata: event.metadata, python: event.python, rev: event.rev, dirty: true } })
        return
      case 'save':
        this.set({ nb: { ...nb, dirty: event.dirty, conflict: event.conflict } })
        return
    }
  }

  // ----- actions (the host applies and broadcasts; local state follows the events) -----

  private call<T>(method: string, args: Record<string, unknown> = {}): Promise<Envelope<T>> {
    return rpc<T>(method, { sessionId: this.sessionId, path: this.path, ...args })
  }

  edit = (...ops: EditOp[]): Promise<Envelope<{ rev: number }>> => this.call('edit', { ops })
  run = (cells: string[], stopOnError = true): Promise<Envelope<{ queued: number }>> => this.call('run', { cells, stopOnError })
  interrupt = (): Promise<Envelope<object>> => this.call('interrupt')
  restart = (): Promise<Envelope<object>> => this.call('restart')
  stop = (): Promise<Envelope<object>> => this.call('stop')
  save = (force = false): Promise<Envelope<object>> => this.call('save', { force })
  reload = (): Promise<Envelope<object>> => this.call('reload')
  setPython = (python: string): Promise<Envelope<object>> => this.call('python', { python })
  interpreters = (): Promise<Envelope<InterpreterOption[]>> => this.call('interpreters')
  createEnv = (packages: string[]): Promise<Envelope<{ python: string; message: string }>> => this.call('createEnv', { packages })
  rawUrl = (path: string): string => `${BASE}/raw?sessionId=${encodeURIComponent(this.sessionId)}&path=${encodeURIComponent(path)}`
}
