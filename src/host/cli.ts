/** Spawns the Composio CLI. Explicit minimal env; JSON on stdout; hard timeout and output cap; arguments via stdin (`-d -`). */
import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'

export interface CliResult { code: number; stdout: string; stderr: string; truncated: boolean }
export class CliError extends Error {
  constructor(readonly code: 'missing' | 'timeout' | 'failed' | 'bad-json', message: string, readonly stderr = '') { super(message) }
}

export interface CliOptions { bin?: string; outputDir?: string; timeoutMs?: number; maxBytes?: number }

export class ComposioCli {
  private readonly bin: string
  constructor(private readonly options: CliOptions = {}) { this.bin = options.bin ?? process.env['COMPOSIO_BIN'] ?? join(homedir(), '.composio', 'composio') }

  run(args: readonly string[], opts: { stdin?: string; timeoutMs?: number; signal?: AbortSignal } = {}): Promise<CliResult> {
    const timeoutMs = opts.timeoutMs ?? this.options.timeoutMs ?? 60_000
    const maxBytes = this.options.maxBytes ?? 4_000_000
    const env: Record<string, string> = { HOME: process.env['HOME'] ?? homedir(), PATH: process.env['PATH'] ?? '/usr/bin:/bin', NO_COLOR: '1' }
    for (const [k, v] of Object.entries(process.env)) if (k.startsWith('COMPOSIO_') && typeof v === 'string' && k !== 'COMPOSIO_USER_API_KEY') env[k] = v
    if (this.options.outputDir !== undefined) env['COMPOSIO_RUN_OUTPUT_DIR'] = this.options.outputDir
    return new Promise((resolve, reject) => {
      let child: ReturnType<typeof spawn>
      try { child = spawn(this.bin, [...args], { env, stdio: ['pipe', 'pipe', 'pipe'] }) } catch (error) { reject(new CliError('missing', `Cannot start the Composio CLI at ${this.bin}: ${String(error)}`)); return }
      let stdout = ''; let stderr = ''; let truncated = false; let done = false
      const finish = (fn: () => void): void => { if (!done) { done = true; clearTimeout(timer); opts.signal?.removeEventListener('abort', onAbort); fn() } }
      const kill = (): void => { try { child.kill('SIGKILL') } catch { /* gone */ } }
      const timer = setTimeout(() => { kill(); finish(() => { reject(new CliError('timeout', `composio ${args[0] ?? ''} timed out after ${String(timeoutMs / 1000)} s`)) }) }, timeoutMs)
      const onAbort = (): void => { kill(); finish(() => { reject(new CliError('failed', 'cancelled')) }) }
      opts.signal?.addEventListener('abort', onAbort, { once: true })
      child.stdout?.on('data', (d: Buffer) => { if (stdout.length < maxBytes) stdout += d.toString('utf8'); else truncated = true })
      child.stderr?.on('data', (d: Buffer) => { if (stderr.length < 100_000) stderr += d.toString('utf8') })
      child.on('error', (error: NodeJS.ErrnoException) => { finish(() => { reject(new CliError(error.code === 'ENOENT' ? 'missing' : 'failed', error.code === 'ENOENT' ? `Composio CLI not found at ${this.bin}` : String(error))) }) })
      child.on('close', (code) => { finish(() => { resolve({ code: code ?? -1, stdout, stderr, truncated }) }) })
      if (opts.stdin !== undefined) child.stdin?.end(opts.stdin); else child.stdin?.end()
    })
  }

  async json(args: readonly string[], opts: { stdin?: string; timeoutMs?: number; signal?: AbortSignal } = {}): Promise<unknown> {
    const r = await this.run(args, opts)
    const text = r.stdout.trim()
    if (text === '') {
      if (r.code !== 0) throw new CliError('failed', `composio ${args[0] ?? ''} failed (exit ${String(r.code)}): ${r.stderr.trim().slice(0, 300)}`, r.stderr)
      return null
    }
    try { return JSON.parse(text) as unknown } catch {
      if (r.code !== 0) throw new CliError('failed', `composio ${args[0] ?? ''} failed (exit ${String(r.code)}): ${(r.stderr || text).trim().slice(0, 300)}`, r.stderr)
      throw new CliError('bad-json', `composio ${args[0] ?? ''} did not return JSON`, r.stderr)
    }
  }
}
