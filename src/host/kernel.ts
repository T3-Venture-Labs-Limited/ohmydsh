/**
 * One host-owned kernel process: the Python sidecar (python/kernel_driver.py) driving a real ipykernel over
 * line-delimited JSON. The sidecar runs as a managed subprocess, so its process tree is killed with the plugin,
 * and it has its own parent watchdog for the case where dsh itself dies.
 */
import { Readable } from 'node:stream'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-subprocess'
import type { SubprocessHandle } from '@deepseek-ai/dsh-subprocess'
import type { JsonObject, KernelInfo } from '../core/types.ts'
import { INSTALL_HINT } from './python.ts'

async function* lines(readable: Readable): AsyncGenerator<string> {
  let buffer = ''
  for await (const chunk of readable) {
    buffer += (chunk as Buffer).toString('utf8')
    let index: number
    while ((index = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, index)
      buffer = buffer.slice(index + 1)
      if (line !== '') yield line
    }
  }
  if (buffer !== '') yield buffer
}

export interface RunResult { status: 'ok' | 'error' | 'timeout' | 'aborted'; executionCount: number | null; kernelState: string }

export type KernelEvent =
  | { kind: 'output'; output: JsonObject }
  | { kind: 'clear'; wait: boolean }

interface Pending {
  resolve: (value: JsonObject) => void
  reject: (error: Error) => void
  onEvent?: (event: KernelEvent) => void
}

export interface StartOptions {
  python: string
  cwd: string
  kernelName?: string | undefined
}

export class KernelProcess {
  private handle: SubprocessHandle | undefined
  private readonly pending = new Map<string, Pending>()
  private seq = 0
  private ready: Promise<void> | undefined
  private disposed = false
  info: KernelInfo = { status: 'none' }
  /** Called whenever `info` changes. */
  onInfo: (info: KernelInfo) => void = () => {}

  constructor(private readonly ctx: Context, private readonly driverPath: string) {}

  private setInfo(info: KernelInfo): void {
    this.info = info
    this.onInfo(info)
  }

  /** Record a failure that happened before a kernel existed (e.g. no interpreter found). */
  fail(message: string): void {
    this.setInfo({ status: 'error', message, ...this.info.python === undefined ? {} : { python: this.info.python } })
  }

  get alive(): boolean {
    return this.handle !== undefined && !this.disposed
  }

  /** Spawn the sidecar and start the kernel. Idempotent while starting or alive. */
  start(options: StartOptions): Promise<void> {
    if (this.ready !== undefined) return this.ready
    this.ready = this.boot(options).catch((error: unknown) => {
      this.ready = undefined
      throw error
    })
    return this.ready
  }

  private async boot(options: StartOptions): Promise<void> {
    this.disposed = false
    this.setInfo({ status: 'starting', python: options.python })
    const handle = this.ctx.subprocess.spawn({
      argv: [options.python, this.driverPath],
      cwd: options.cwd,
      stdio: { stdin: 'pipe', stdout: 'pipe', stderr: { maxBytes: 64 * 1024 } },
      graceMs: 5_000,
      env: { PYTHONUNBUFFERED: '1', PYDEVD_DISABLE_FILE_VALIDATION: '1' },
    })
    this.handle = handle
    void this.drain(handle)
    void handle.done.then(() => this.onExit(handle), () => this.onExit(handle))
    try {
      const reply = await this.request('start', {
        interpreter: options.python,
        cwd: options.cwd,
        ...options.kernelName === undefined ? {} : { kernel_name: options.kernelName },
      }, undefined, 90_000)
      const kernelInfo = (reply.kernel_info ?? {}) as JsonObject
      this.setInfo({
        status: 'idle',
        python: options.python,
        language: typeof reply.language === 'string' ? reply.language : 'python',
        ...typeof kernelInfo.version === 'string' ? { version: kernelInfo.version } : {},
      })
    } catch (error) {
      const raw = error instanceof Error ? error.message : String(error)
      const missing = /No module named '?(jupyter_client|ipykernel)/i.test(raw) || /ModuleNotFoundError/.test(raw) || /No module named/.test(this.stderrTail())
      const message = missing ? INSTALL_HINT(options.python) : `${raw}${this.stderrTail() === '' ? '' : `\n${this.stderrTail().slice(-400)}`}`
      this.kill()
      this.setInfo({ status: 'error', python: options.python, message })
      throw new Error(message)
    }
  }

  private stderrTail(): string {
    try {
      return this.handle?.collected.stderr?.readFrom(0).text.trim() ?? ''
    } catch {
      return ''
    }
  }

  private async drain(handle: SubprocessHandle): Promise<void> {
    const stdout = handle.stdout
    if (stdout === undefined) return
    for await (const line of lines(stdout)) {
      let message: JsonObject
      try {
        message = JSON.parse(line) as JsonObject
      } catch {
        continue
      }
      const id = typeof message.id === 'string' ? message.id : undefined
      if (id === undefined) continue
      const pending = this.pending.get(id)
      if (pending === undefined) continue
      if (message.event === 'output' && typeof message.output === 'object' && message.output !== null) {
        pending.onEvent?.({ kind: 'output', output: message.output as JsonObject })
      } else if (message.event === 'clear') {
        pending.onEvent?.({ kind: 'clear', wait: message.wait === true })
      } else if (message.ok === true) {
        this.pending.delete(id)
        pending.resolve(message)
      } else if (message.ok === false) {
        this.pending.delete(id)
        pending.reject(new Error(typeof message.error === 'string' ? message.error : 'kernel request failed'))
      }
    }
  }

  private onExit(handle: SubprocessHandle): void {
    if (this.handle !== handle) return
    this.handle = undefined
    this.ready = undefined
    for (const [id, pending] of this.pending) {
      this.pending.delete(id)
      pending.reject(new Error('The kernel process exited.'))
    }
    if (!this.disposed && this.info.status !== 'error') this.setInfo({ ...this.info, status: 'dead', message: 'The kernel process exited unexpectedly. Restart it to continue.' })
  }

  /** Send one command; events stream to `onEvent` until the reply arrives. */
  request(cmd: string, args: JsonObject, onEvent?: (event: KernelEvent) => void, timeoutMs?: number): Promise<JsonObject> {
    const handle = this.handle
    if (handle === undefined || handle.stdin === undefined) return Promise.reject(new Error('The kernel is not running.'))
    const id = `r${++this.seq}`
    return new Promise<JsonObject>((resolve, reject) => {
      const timer = timeoutMs === undefined ? undefined : setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`The kernel did not answer "${cmd}" within ${Math.round(timeoutMs / 1000)} s.`))
      }, timeoutMs)
      const settle = <T>(fn: (v: T) => void) => (v: T): void => { if (timer !== undefined) clearTimeout(timer); fn(v) }
      this.pending.set(id, { resolve: settle(resolve), reject: settle(reject), ...onEvent === undefined ? {} : { onEvent } })
      handle.stdin?.write(JSON.stringify({ id, cmd, ...args }) + '\n')
    })
  }

  /** Execute code; `timeoutS` of 0 means no limit. */
  async execute(code: string, timeoutS: number, onEvent: (event: KernelEvent) => void): Promise<RunResult> {
    this.setInfo({ ...this.info, status: 'busy' })
    try {
      const reply = await this.request('execute', { code, timeout: timeoutS }, onEvent)
      const state = typeof reply.kernel_state === 'string' ? reply.kernel_state : 'idle'
      if (state === 'dead') this.setInfo({ ...this.info, status: 'dead', message: 'The kernel died while running the cell.' })
      else this.setInfo({ ...this.info, status: 'idle' })
      return {
        status: (reply.status === 'error' || reply.status === 'timeout' || reply.status === 'aborted' ? reply.status : 'ok'),
        executionCount: typeof reply.execution_count === 'number' ? reply.execution_count : null,
        kernelState: state,
      }
    } catch (error) {
      if (this.info.status === 'busy') this.setInfo({ ...this.info, status: this.handle === undefined ? 'dead' : 'idle' })
      throw error
    }
  }

  interrupt(): void {
    if (this.handle !== undefined) void this.request('interrupt', {}, undefined, 10_000).catch(() => {})
  }

  /** Restart the kernel in place (fresh namespace, same sidecar). */
  async restart(): Promise<void> {
    this.setInfo({ ...this.info, status: 'starting' })
    try {
      await this.request('restart', {}, undefined, 60_000)
      this.setInfo({ ...this.info, status: 'idle' })
    } catch (error) {
      this.kill()
      throw error
    }
  }

  /** Ask the sidecar to shut the kernel tree down, then make sure the process is gone. */
  async stop(): Promise<void> {
    const handle = this.handle
    this.disposed = true
    if (handle !== undefined) {
      try {
        await this.request('stop', {}, undefined, 4_000)
      } catch { /* fall through to terminate */ }
      handle.terminate()
    }
    this.handle = undefined
    this.ready = undefined
    for (const [id, pending] of this.pending) {
      this.pending.delete(id)
      pending.reject(new Error('The kernel was stopped.'))
    }
    this.info = { status: 'none' }
    this.onInfo(this.info)
  }

  private kill(): void {
    try { this.handle?.terminate() } catch { /* already gone */ }
    this.handle = undefined
    this.ready = undefined
  }

  /** Bounded variable and object introspection (never reads values unless asked). */
  introspect(cmd: 'list_vars' | 'inspect_object', args: JsonObject): Promise<JsonObject> {
    return this.request(cmd, args, undefined, 30_000)
  }
}
