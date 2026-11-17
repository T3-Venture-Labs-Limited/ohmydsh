// Test doubles for the slice of the DSH context the host uses: a node-fs backed `fs` and a child_process `subprocess`.
import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, statSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { Readable, Writable } from 'node:stream'

export const TEST_PYTHON = process.env.DSH_NOTEBOOK_TEST_PYTHON ?? resolve(import.meta.dirname, '../../.tmp/research/nb/venv/bin/python')
export const hasPython = existsSync(TEST_PYTHON)

interface Target { path: string }

class FsError extends Error { constructor(readonly code: string, message: string) { super(message) } }

export function makeFs(root: string, listeners?: { writes: string[] }) {
  const versionOf = (path: string): string | undefined => { try { const s = statSync(path); return `${s.mtimeMs}:${s.size}` } catch { return undefined } }
  return {
    resolve: async (p: string, o?: { cwd?: string }): Promise<Target> => ({ path: resolve(o?.cwd ?? root, p) }),
    contains: (parent: Target, child: Target): boolean => child.path === parent.path || child.path.startsWith(parent.path + '/'),
    processPath: (t: Target): string => t.path,
    stat: async (t: Target) => { try { const s = statSync(t.path); return { version: versionOf(t.path), type: s.isDirectory() ? 'directory' : 'file', size: s.size } } catch { return undefined } },
    readText: async (t: Target): Promise<string> => readFileSync(t.path, 'utf8'),
    readBytes: async (t: Target): Promise<Uint8Array> => readFileSync(t.path),
    watch: async () => { throw new Error('unsupported') },
    writeText: async (t: Target, text: string, guard?: { kind: string; version?: string }) => {
      const current = versionOf(t.path)
      if (guard?.kind === 'replaceIfVersion' && current !== guard.version) throw new FsError('FS_STALE_VERSION', 'stale')
      if (guard?.kind === 'createIfAbsent' && current !== undefined) throw new FsError('FS_ALREADY_EXISTS', 'exists')
      mkdirSync(dirname(t.path), { recursive: true })
      writeFileSync(t.path, text)
      listeners?.writes.push(t.path)
      return { version: versionOf(t.path) }
    },
  }
}

export function makeSubprocess() {
  const live = new Set<{ kill: () => void }>()
  return {
    live,
    resolveExecutable: async (name: string): Promise<string | undefined> => (name === 'python3' ? TEST_PYTHON : undefined),
    spawn: (spec: { argv: string[]; cwd: string; env?: NodeJS.ProcessEnv }) => {
      const child = spawn(spec.argv[0] as string, spec.argv.slice(1), { cwd: spec.cwd, env: { ...process.env, ...spec.env }, stdio: ['pipe', 'pipe', 'pipe'], detached: true })
      let tail = ''
      child.stderr.on('data', (d: Buffer) => { tail = (tail + d.toString()).slice(-60_000) })
      const entry = { kill: () => { try { process.kill(-(child.pid as number), 'SIGKILL') } catch { /* gone */ } } }
      live.add(entry)
      const done = new Promise((res) => child.on('close', (code) => { live.delete(entry); res({ exitCode: code, signal: null }) }))
      return {
        stdin: child.stdin as Writable,
        stdout: child.stdout as Readable,
        stderr: child.stderr as Readable,
        collected: { stderr: { readFrom: () => ({ text: tail, nextOffset: tail.length, lossy: false }) } },
        done,
        terminate: () => { try { child.kill('SIGTERM') } catch { /* gone */ } setTimeout(entry.kill, 1500).unref() },
        waitForExit: async () => true,
        control: undefined,
      }
    },
  }
}

export function makeCtx(root: string, mode: 'read-only' | 'workspace-write' | 'danger-full-access' = 'danger-full-access') {
  const fs = makeFs(root)
  const subprocess = makeSubprocess()
  const ctx = {
    fs,
    subprocess,
    sandboxPolicy: { resolve: () => ({ mode, workspaceRoot: root }) },
    sessions: { get: () => ({ header: { cwd: root } }) },
    logger: { warn: () => {} },
    get: () => undefined,
  }
  return { ctx: ctx as never, fs, subprocess }
}
