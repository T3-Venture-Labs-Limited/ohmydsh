/**
 * The notebook document: the single host-side source of truth for one notebook file.
 * The sidebar UI and the agent tools both go through it, so cells, outputs and the one kernel stay in sync;
 * every change is pushed to connected views as an event (no polling).
 */
import { dirname } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { FsTarget, FsVersion } from '@deepseek-ai/dsh-fs'
import type {} from '@deepseek-ai/dsh-fs'
import type { SandboxPolicyService } from '@deepseek-ai/dsh-sandbox-policy'
import type { EditOp, JsonObject, KernelInfo, NotebookEvent, WireCell, WireNotebook } from '../core/types.ts'
import { emptyNotebook, newCellId, parseNotebook, serializeNotebook } from '../core/ipynb.ts'
import type { DocCell } from '../core/ipynb.ts'
import { KernelProcess } from './kernel.ts'
import type { KernelEvent } from './kernel.ts'
import { annotate, approveInterpreter, discoverInterpreters, pickDefault } from './python.ts'
import type { Settings } from './settings.ts'

/** The resolved sandbox policy for one session (mode + workspace root). */
export type SandboxExecutionPolicy = ReturnType<SandboxPolicyService['resolve']>

export const NOTEBOOK_CAP_BYTES = 32 << 20

export class NotebookError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'NotebookError'
  }
}

/** Caller identity for permission-sensitive operations. */
export interface DocScope {
  sessionId: string
  /** Workspace root (session header cwd). */
  root: string
  rootTarget: FsTarget
  policy: SandboxExecutionPolicy
}

export interface CellRunResult {
  id: string
  index: number
  status: 'ok' | 'error' | 'timeout' | 'aborted' | 'skipped'
  executionCount: number | null
  ms: number
}

export interface RunReport {
  results: CellRunResult[]
  /** Cells that never ran because an earlier one failed or the run was interrupted. */
  notRun: string[]
  kernel: KernelInfo
}

const ENV_KEY = 'dsh_notebook'

type Listener = (event: NotebookEvent) => void

function fsCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error ? String((error as { code: unknown }).code) : undefined
}

export class NotebookDocument {
  rev = 1
  cells: DocCell[] = []
  metadata: JsonObject = {}
  minor = 5
  extras: JsonObject = {}
  dirty = false
  conflict = false
  lastUsed = Date.now()
  readonly kernel: KernelProcess
  /** The session that last used this document. */
  get sessionId(): string { return this.lastScope.sessionId }
  /** Set by the owner; called on every touch so idle timers can re-arm. */
  onTouch: () => void = () => {}
  private version: FsVersion | undefined
  private python = ''
  private readonly listeners = new Set<Listener>()
  private chain: Promise<unknown> = Promise.resolve()
  private batches = new Set<{ cancelled: boolean }>()
  private generation = 0
  private running: string | undefined
  private saveTimer: NodeJS.Timeout | undefined
  private saving: Promise<void> | undefined
  private outBuffer: NotebookEvent[] = []
  private outTimer: NodeJS.Timeout | undefined
  private closeWatch: (() => Promise<void>) | undefined
  private watchStop = new AbortController()
  private checkTimer: NodeJS.Timeout | undefined
  private disposed = false

  constructor(
    private readonly ctx: Context,
    readonly target: FsTarget,
    /** Path relative to the workspace root, for display and tool results. */
    readonly path: string,
    private lastScope: DocScope,
    private readonly settings: Settings,
    driverPath: string,
  ) {
    this.kernel = new KernelProcess(ctx, driverPath)
    this.kernel.onInfo = (kernel) => {
      // A kernel that is gone or starting over has an empty namespace again.
      if (kernel.status === 'none' || kernel.status === 'dead' || kernel.status === 'error' || kernel.status === 'starting') this.runs = 0
      this.emit({ t: 'kernel', kernel: this.kernelInfo(kernel) })
    }
  }

  // ---------- loading ----------

  /** Read the file (or start an empty notebook when it is absent and `create` is set). */
  async load(create: boolean): Promise<void> {
    const info = await this.ctx.fs.stat(this.target)
    if (info === undefined) {
      if (!create) throw new NotebookError('not-found', `${this.path} does not exist.`)
      this.adopt(emptyNotebook())
      this.dirty = true
      return
    }
    if (info.type !== 'file') throw new NotebookError('not-found', `${this.path} is not a file.`)
    if (info.size !== undefined && info.size > NOTEBOOK_CAP_BYTES) throw new NotebookError('too-large', `${this.path} is larger than ${NOTEBOOK_CAP_BYTES >> 20} MB.`)
    const text = await this.ctx.fs.readText(this.target)
    this.version = info.version
    if (text.trim() === '') {
      this.adopt(emptyNotebook())
      this.dirty = true
      return
    }
    const parsed = parseNotebook(text)
    if ('error' in parsed) throw new NotebookError('not-notebook', parsed.error)
    this.adopt(parsed)
    this.dirty = false
  }

  private adopt(parsed: { cells: DocCell[]; metadata: JsonObject; minor: number; extras: JsonObject }): void {
    this.cells = parsed.cells
    this.metadata = parsed.metadata
    this.minor = parsed.minor
    this.extras = parsed.extras
    this.python = this.pinnedFromMetadata()
    this.conflict = false
  }

  /** Start watching the file for outside changes; falls back to checks at connect/save time when unsupported. */
  async startWatching(): Promise<void> {
    if (this.closeWatch !== undefined || this.disposed) return
    try {
      this.closeWatch = await this.ctx.fs.watch(this.target, () => this.scheduleCheck(), this.watchStop.signal)
    } catch {
      this.closeWatch = undefined
    }
  }

  private scheduleCheck(): void {
    if (this.checkTimer !== undefined) return
    this.checkTimer = setTimeout(() => {
      this.checkTimer = undefined
      void this.checkDisk()
    }, 300)
    this.checkTimer.unref?.()
  }

  /** Compare the file on disk with the version this document last read or wrote. */
  async checkDisk(): Promise<void> {
    if (this.disposed || this.saving !== undefined) return
    let info
    try {
      info = await this.ctx.fs.stat(this.target)
    } catch {
      return
    }
    if (info === undefined || this.version === undefined || String(info.version) === String(this.version)) return
    if (this.dirty) {
      if (!this.conflict) {
        this.conflict = true
        this.emit({ t: 'save', dirty: this.dirty, conflict: true })
      }
      return
    }
    await this.reloadFromDisk()
  }

  /** Replace the document with the file on disk (cells keep their ids; the kernel is left alone). */
  async reloadFromDisk(): Promise<void> {
    await this.load(false)
    this.rev += 1
    this.emit({ t: 'snap', nb: this.snapshot() })
  }

  /** Record the caller whose permissions govern the next autosave and the workspace used for discovery. */
  use(scope: DocScope): void {
    this.lastScope = scope
    this.touch()
  }

  isRunning(id: string): boolean {
    return this.runState.has(id)
  }

  /** Throws unless the caller's session may modify files. */
  assertWritable(scope: DocScope): void {
    if (scope.policy.mode === 'read-only') throw new NotebookError('read-only', 'This session is read-only: notebooks cannot be edited or saved.')
    this.use(scope)
  }

  // ---------- views ----------

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    this.touch()
    return () => {
      this.listeners.delete(listener)
      this.touch()
    }
  }

  get viewers(): number {
    return this.listeners.size
  }

  touch(): void {
    this.lastUsed = Date.now()
    this.onTouch()
  }

  /** True while there is a reason to keep the kernel: a view, a queued or running cell. */
  get busy(): boolean {
    return this.running !== undefined || this.batches.size > 0
  }

  private emit(event: NotebookEvent): void {
    if (event.t === 'out' && event.append === true) {
      const last = this.outBuffer.at(-1)
      if (last !== undefined && last.t === 'out' && last.append === true && last.id === event.id && last.output.name === event.output.name) {
        last.output = { ...last.output, text: String(last.output.text ?? '') + String(event.output.text ?? '') }
        last.rev = event.rev
      } else {
        this.outBuffer.push(event)
      }
      if (this.outTimer === undefined) {
        this.outTimer = setTimeout(() => this.flushOut(), 40)
        this.outTimer.unref?.()
      }
      return
    }
    this.flushOut()
    this.dispatch(event)
  }

  private flushOut(): void {
    if (this.outTimer !== undefined) clearTimeout(this.outTimer)
    this.outTimer = undefined
    const buffered = this.outBuffer
    this.outBuffer = []
    for (const event of buffered) this.dispatch(event)
  }

  private dispatch(event: NotebookEvent): void {
    for (const listener of this.listeners) {
      try { listener(event) } catch { /* a dead connection must not break the others */ }
    }
  }

  toWire(cell: DocCell): WireCell {
    return {
      id: cell.id,
      cell_type: cell.cell_type,
      source: cell.source,
      execution_count: cell.execution_count,
      outputs: cell.outputs,
      metadata: cell.metadata,
      rev: cell.rev,
      ...cell.cell_type === 'markdown' && typeof cell.extras.attachments === 'object' && cell.extras.attachments !== null ? { attachments: cell.extras.attachments as JsonObject } : {},
      ...this.runState.get(cell.id) !== undefined ? { run: this.runState.get(cell.id) as 'queued' | 'running' } : {},
    }
  }

  private runState = new Map<string, 'queued' | 'running'>()
  private runs = 0

  private kernelInfo(info: KernelInfo = this.kernel.info): KernelInfo {
    return { ...info, runs: this.runs }
  }

  snapshot(scope?: DocScope): WireNotebook {
    return {
      path: this.path,
      rev: this.rev,
      cells: this.cells.map((cell) => this.toWire(cell)),
      metadata: this.metadata,
      kernel: this.kernelInfo(),
      dirty: this.dirty,
      conflict: this.conflict,
      readOnly: (scope ?? this.lastScope).policy.mode === 'read-only',
      python: this.python,
    }
  }

  // ---------- editing ----------

  cellIndex(ref: string | number | undefined): number {
    if (typeof ref === 'number') return ref
    if (ref === undefined) return -1
    const index = this.cells.findIndex((cell) => cell.id === ref)
    if (index < 0) throw new NotebookError('no-such-cell', `No cell with id "${ref}".`)
    return index
  }

  private bumpDirty(): void {
    this.rev += 1
    if (!this.dirty) this.dirty = true
    this.scheduleSave()
  }

  /** Apply one edit. Returns the ids it touched. */
  edit(op: EditOp, by?: string): string[] {
    this.touch()
    switch (op.op) {
      case 'insert': {
        const ids = new Set(this.cells.map((c) => c.id))
        const id = op.id !== undefined && !ids.has(op.id) ? op.id : newCellId(ids)
        const at = op.after === undefined ? this.cells.length : this.cellIndex(op.after) + 1
        if (at < 0 || at > this.cells.length) throw new NotebookError('bad-position', `Position ${at} is outside the notebook (0..${this.cells.length}).`)
        const cell: DocCell = { id, cell_type: op.cell_type ?? 'code', source: op.source ?? '', execution_count: null, outputs: [], metadata: {}, rev: 1, outputsDirty: true, extras: {} }
        this.cells.splice(at, 0, cell)
        this.bumpDirty()
        this.emit({ t: 'cell', rev: this.rev, index: at, cell: this.toWire(cell), ...by === undefined ? {} : { by } })
        this.emit({ t: 'order', rev: this.rev, ids: this.cells.map((c) => c.id), ...by === undefined ? {} : { by } })
        return [id]
      }
      case 'source': {
        const index = this.cellIndex(op.id)
        const cell = this.cells[index] as DocCell
        if (cell.source === op.source) return [cell.id]
        cell.source = op.source
        cell.rev += 1
        this.bumpDirty()
        this.emit({ t: 'cell', rev: this.rev, index, cell: this.toWire(cell), ...by === undefined ? {} : { by } })
        return [cell.id]
      }
      case 'type': {
        const index = this.cellIndex(op.id)
        const cell = this.cells[index] as DocCell
        if (cell.cell_type === op.cell_type) return [cell.id]
        cell.cell_type = op.cell_type
        if (op.cell_type !== 'code') { cell.outputs = []; cell.execution_count = null }
        cell.outputsDirty = true
        cell.rev += 1
        this.bumpDirty()
        this.emit({ t: 'cell', rev: this.rev, index, cell: this.toWire(cell), ...by === undefined ? {} : { by } })
        return [cell.id]
      }
      case 'delete': {
        const index = this.cellIndex(op.id)
        const [cell] = this.cells.splice(index, 1)
        this.runState.delete(op.id)
        this.bumpDirty()
        this.emit({ t: 'order', rev: this.rev, ids: this.cells.map((c) => c.id), ...by === undefined ? {} : { by } })
        return cell === undefined ? [] : [cell.id]
      }
      case 'move': {
        const index = this.cellIndex(op.id)
        if (!Number.isInteger(op.to) || op.to < 0 || op.to >= this.cells.length) throw new NotebookError('bad-position', `Target position must be 0..${this.cells.length - 1}.`)
        const [cell] = this.cells.splice(index, 1)
        if (cell !== undefined) this.cells.splice(op.to, 0, cell)
        this.bumpDirty()
        this.emit({ t: 'order', rev: this.rev, ids: this.cells.map((c) => c.id), ...by === undefined ? {} : { by } })
        return [op.id]
      }
      case 'clear': {
        const targets = op.id === undefined ? this.cells.filter((c) => c.cell_type === 'code') : [this.cells[this.cellIndex(op.id)] as DocCell]
        for (const cell of targets) {
          if (this.runState.has(cell.id)) continue
          cell.outputs = []
          cell.execution_count = null
          cell.outputsDirty = true
          cell.rev += 1
          this.rev += 1
          this.emit({ t: 'clear', rev: this.rev, id: cell.id })
        }
        this.bumpDirty()
        return targets.map((c) => c.id)
      }
    }
  }

  // ---------- kernel ----------

  private pinnedFromMetadata(): string {
    const section = this.metadata[ENV_KEY]
    const value = typeof section === 'object' && section !== null ? (section as JsonObject).python : undefined
    if (typeof value !== 'string' || value === '') return ''
    return value.startsWith('./') || value.startsWith('../') ? this.ctx.fs.processPath(this.target).replace(/[^/\\]*$/, '') + value : value
  }

  get chosenPython(): string {
    return this.python
  }

  /** Choose the interpreter (empty = discover). Restarts the kernel on the next run; stops a live one. */
  async setPython(python: string, remember: boolean): Promise<void> {
    // Only reached from an explicit user action (sidebar picker / created environment) or an approved agent `nb_env`:
    // that is what makes an interpreter inside the workspace startable (NB-1).
    await approveInterpreter(python)
    this.python = python
    if (remember) {
      const section = { ...(typeof this.metadata[ENV_KEY] === 'object' && this.metadata[ENV_KEY] !== null ? this.metadata[ENV_KEY] as JsonObject : {}) }
      if (python === '') delete section.python
      else {
        const dir = dirname(this.ctx.fs.processPath(this.target))
        section.python = python.startsWith(dir + '/') ? `./${python.slice(dir.length + 1)}` : python
      }
      this.metadata = { ...this.metadata, [ENV_KEY]: section }
      this.bumpDirty()
      this.emit({ t: 'meta', rev: this.rev, metadata: this.metadata, python })
    } else {
      this.emit({ t: 'meta', rev: this.rev, metadata: this.metadata, python })
    }
    if (this.kernel.alive) await this.stopKernel()
  }

  async resolvePython(): Promise<string> {
    const dir = dirname(this.ctx.fs.processPath(this.target))
    const options = await annotate(await discoverInterpreters({
      workspaceRoot: this.lastScope.root,
      notebookDir: dir,
      pinned: this.python === '' ? undefined : this.python,
      configured: this.settings.python,
      resolveExecutable: async (name) => {
        try { return await this.ctx.subprocess.resolveExecutable(name) } catch { return undefined }
      },
    }))
    const chosen = pickDefault(options)
    if (chosen === undefined) {
      const held = options.filter((o) => o.trusted !== true)
      if (held.length > 0) {
        throw new NotebookError('no-python', `Found ${held.map((o) => o.python).join(', ')} but it lies inside the workspace or was pinned by the notebook file, so it is not started automatically. Pick it in the Python environment menu to trust it, or install Python / set DSH_NOTEBOOK_PYTHON.`)
      }
      throw new NotebookError('no-python', 'No Python interpreter was found. Install Python or set DSH_NOTEBOOK_PYTHON, then try again (or use "Create notebook environment").')
    }
    return chosen.python
  }

  async ensureKernel(): Promise<void> {
    if (this.kernel.alive && this.kernel.info.status !== 'dead' && this.kernel.info.status !== 'error') {
      await this.kernel.start({ python: this.kernel.info.python ?? '', cwd: '' })
      return
    }
    const python = await this.resolvePython()
    const cwd = dirname(this.ctx.fs.processPath(this.target))
    try {
      await this.kernel.start({ python, cwd })
    } catch (error) {
      throw new NotebookError('kernel-unavailable', error instanceof Error ? error.message : String(error))
    }
    const lang = this.kernel.info.language ?? 'python'
    if (this.metadata.kernelspec === undefined && lang === 'python') {
      this.metadata = { ...this.metadata, kernelspec: { display_name: 'Python 3 (ipykernel)', language: 'python', name: 'python3' }, language_info: { name: 'python', ...this.kernel.info.version === undefined ? {} : { version: this.kernel.info.version } } }
    }
  }

  async stopKernel(): Promise<void> {
    this.generation += 1
    for (const batch of this.batches) batch.cancelled = true
    await this.kernel.stop()
    this.clearRunState()
  }

  private clearRunState(): void {
    for (const id of [...this.runState.keys()]) {
      this.runState.delete(id)
      this.emit({ t: 'run', rev: this.rev, id, run: null })
    }
  }

  interrupt(): void {
    this.touch()
    for (const batch of this.batches) batch.cancelled = true
    this.kernel.interrupt()
  }

  async restartKernel(): Promise<void> {
    this.touch()
    this.generation += 1
    for (const batch of this.batches) batch.cancelled = true
    if (!this.kernel.alive) {
      this.clearRunState()
      return
    }
    await this.kernel.restart()
    this.runs = 0
    this.emit({ t: 'kernel', kernel: this.kernelInfo() })
    this.clearRunState()
  }

  // ---------- execution ----------

  /**
   * Queue cells for execution. Runs are strictly sequential per notebook; the returned promise settles when
   * every requested cell has run, been skipped, or been cancelled.
   */
  run(ids: string[], options: { timeoutS: number; stopOnError: boolean }): Promise<RunReport> {
    this.touch()
    const batch = { cancelled: false }
    this.batches.add(batch)
    const generation = this.generation
    const queued = ids.filter((id) => {
      const cell = this.cells.find((c) => c.id === id)
      return cell !== undefined && cell.cell_type === 'code' && cell.source.trim() !== ''
    })
    for (const id of queued) {
      this.runState.set(id, 'queued')
      this.emit({ t: 'run', rev: this.rev, id, run: 'queued' })
    }
    const job = this.chain.then(() => this.runBatch(queued, ids, batch, generation, options))
    this.chain = job.catch(() => {})
    return job.finally(() => { this.batches.delete(batch); this.touch() })
  }

  private async runBatch(queued: string[], requested: string[], batch: { cancelled: boolean }, generation: number, options: { timeoutS: number; stopOnError: boolean }): Promise<RunReport> {
    const results: CellRunResult[] = []
    const notRun: string[] = requested.filter((id) => !queued.includes(id))
    let failed = false
    for (const id of queued) {
      const cell = this.cells.find((c) => c.id === id)
      if (cell === undefined || batch.cancelled || generation !== this.generation || (failed && options.stopOnError)) {
        notRun.push(id)
        if (this.runState.delete(id)) this.emit({ t: 'run', rev: this.rev, id, run: null })
        continue
      }
      const started = Date.now()
      try {
        const result = await this.runCell(cell, options.timeoutS)
        results.push({ id, index: this.cells.indexOf(cell), status: result.status, executionCount: result.executionCount, ms: Date.now() - started })
        if (result.status !== 'ok') failed = true
      } catch (error) {
        if (this.runState.delete(id)) this.emit({ t: 'run', rev: this.rev, id, run: null })
        failed = true
        notRun.push(id)
        if (error instanceof NotebookError && error.code === 'kernel-unavailable') {
          for (const rest of queued.slice(queued.indexOf(id) + 1)) {
            if (this.runState.delete(rest)) this.emit({ t: 'run', rev: this.rev, id: rest, run: null })
            notRun.push(rest)
          }
          throw error
        }
        results.push({ id, index: this.cells.indexOf(cell), status: 'error', executionCount: null, ms: Date.now() - started })
      }
    }
    return { results, notRun, kernel: this.kernel.info }
  }

  private async runCell(cell: DocCell, timeoutS: number): Promise<{ status: CellRunResult['status']; executionCount: number | null }> {
    await this.ensureKernel()
    this.running = cell.id
    cell.outputs = []
    cell.outputsDirty = true
    cell.execution_count = null
    this.runState.set(cell.id, 'running')
    this.rev += 1
    this.emit({ t: 'clear', rev: this.rev, id: cell.id })
    this.emit({ t: 'run', rev: this.rev, id: cell.id, run: 'running', execution_count: null })
    const cap = this.settings.maxOutputChars
    try {
      const result = await this.kernel.execute(cell.source, timeoutS, (event) => this.onKernelEvent(cell, event, cap))
      cell.execution_count = result.executionCount
      this.runs += 1
      this.emit({ t: 'kernel', kernel: this.kernelInfo() })
      return { status: result.status, executionCount: result.executionCount }
    } finally {
      this.running = undefined
      this.runState.delete(cell.id)
      cell.rev += 1
      this.bumpDirty()
      this.emit({ t: 'run', rev: this.rev, id: cell.id, run: null, execution_count: cell.execution_count })
    }
  }

  private onKernelEvent(cell: DocCell, event: KernelEvent, cap: number): void {
    if (event.kind === 'clear') {
      if (!event.wait) {
        cell.outputs = []
        this.rev += 1
        this.emit({ t: 'clear', rev: this.rev, id: cell.id })
      }
      return
    }
    const output = event.output
    this.rev += 1
    if (output.output_type === 'stream') {
      const name = String(output.name ?? 'stdout')
      const text = String(output.text ?? '')
      const last = cell.outputs.at(-1)
      if (last !== undefined && last.output_type === 'stream' && last.name === name) {
        const merged = String(last.text ?? '') + text
        last.text = merged.length > cap ? `…[earlier output truncated]\n${merged.slice(merged.length - cap)}` : merged
        this.emit({ t: 'out', rev: this.rev, id: cell.id, output: { name, text }, append: true })
        return
      }
      cell.outputs.push({ output_type: 'stream', name, text: text.length > cap ? text.slice(text.length - cap) : text })
      this.emit({ t: 'out', rev: this.rev, id: cell.id, output: { name, text }, append: false })
      return
    }
    cell.outputs.push(output)
    this.emit({ t: 'out', rev: this.rev, id: cell.id, output })
  }

  // ---------- saving ----------

  private scheduleSave(): void {
    if (!this.settings.autosave || this.lastScope.policy.mode === 'read-only' || this.conflict || this.disposed) return
    if (this.saveTimer !== undefined) clearTimeout(this.saveTimer)
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined
      void this.save(this.lastScope).catch(() => {})
    }, 2_500)
    this.saveTimer.unref?.()
  }

  /** Write the notebook with the filesystem version guard; sets `conflict` when the file changed underneath. */
  save(scope: DocScope, force = false): Promise<void> {
    const run = async (): Promise<void> => {
      if (this.saveTimer !== undefined) { clearTimeout(this.saveTimer); this.saveTimer = undefined }
      const text = serializeNotebook({ cells: this.cells, metadata: this.metadata, minor: this.minor, extras: this.extras })
      try {
        const outcome = await this.ctx.fs.writeText(
          this.target,
          text,
          force || this.version === undefined ? (this.version === undefined && !force ? { kind: 'createIfAbsent' } : undefined) : { kind: 'replaceIfVersion', version: this.version },
          undefined,
          scope.policy,
        )
        this.version = outcome.version
        // Outputs and structure now match disk: later saves can reuse the raw form of untouched cells.
        for (const cell of this.cells) { delete cell.raw; cell.outputsDirty = true }
        this.dirty = false
        this.conflict = false
        this.emit({ t: 'save', dirty: false, conflict: false })
      } catch (error) {
        const code = fsCode(error)
        if (code === 'FS_STALE_VERSION' || code === 'FS_ALREADY_EXISTS') {
          this.conflict = true
          this.emit({ t: 'save', dirty: this.dirty, conflict: true })
          throw new NotebookError('write-conflict', 'The file changed on disk since it was loaded. Reload it or overwrite it.')
        }
        if (code === 'FS_SANDBOX_DENIED') throw new NotebookError('write-denied', 'The session sandbox policy does not allow writing this file.')
        if (code === 'FS_PERMISSION_DENIED') throw new NotebookError('write-denied', 'Permission denied while writing the file.')
        throw new NotebookError('write-failed', `Could not write ${this.path}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    const next = (this.saving ?? Promise.resolve()).catch(() => {}).then(run)
    const tracked: Promise<void> = next.then(() => {}, () => {}).then(() => { if (this.saving === tracked) this.saving = undefined })
    this.saving = tracked
    return next
  }

  // ---------- teardown ----------

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    this.watchStop.abort()
    for (const timer of [this.saveTimer, this.outTimer, this.checkTimer]) if (timer !== undefined) clearTimeout(timer)
    if (this.dirty && !this.conflict && this.lastScope.policy.mode !== 'read-only') await this.save(this.lastScope).catch(() => {})
    await this.closeWatch?.().catch(() => {})
    await this.kernel.stop()
    this.listeners.clear()
  }
}
