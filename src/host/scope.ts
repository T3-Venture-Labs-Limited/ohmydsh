/** Workspace scope: which files a caller may touch, and under which sandbox policy. */
import type { Context } from '@deepseek-ai/cordis'
import type { FsTarget } from '@deepseek-ai/dsh-fs'
import type {} from '@deepseek-ai/dsh-fs'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import type {} from '@deepseek-ai/dsh-session'
import type { DocScope } from './document.ts'
import { NotebookError } from './document.ts'

export interface ScopeExtras {
  /** Directory relative paths resolve against (the agent's current directory); defaults to the workspace root. */
  base?: string | undefined
}

/** Resolve a live session to its workspace root and sandbox policy. */
export async function scopeOfSession(ctx: Context, sessionId: string, extras: ScopeExtras = {}): Promise<DocScope & { base: string }> {
  if (sessionId === '') throw new NotebookError('no-session', 'Missing session id.')
  const session = ctx.sessions.get(sessionId as never)
  const cwd = session?.header.cwd
  if (session === undefined || typeof cwd !== 'string' || cwd === '') throw new NotebookError('no-session', 'This session has no working directory.')
  try {
    const rootTarget = await ctx.fs.resolve(cwd)
    // A route handler is not inside the agent's context: carry the session's own mode and workspace root.
    const policy = ctx.sandboxPolicy.resolve({ session })
    return { sessionId, root: cwd, rootTarget, policy, base: extras.base ?? cwd }
  } catch {
    throw new NotebookError('no-session', `Cannot resolve the workspace: ${cwd}`)
  }
}

/** Resolve one path inside the workspace; refuses anything that resolves outside it. */
export async function resolveNotebookPath(ctx: Context, scope: DocScope & { base?: string }, path: string): Promise<FsTarget> {
  if (path === '' || path.includes('\0')) throw new NotebookError('bad-path', 'Invalid path.')
  let target: FsTarget
  try {
    target = await ctx.fs.resolve(path, { cwd: scope.base ?? scope.root })
  } catch {
    throw new NotebookError('bad-path', `Cannot resolve ${path}.`)
  }
  if (!ctx.fs.contains(scope.rootTarget, target)) throw new NotebookError('outside-workspace', `${path} is outside the session workspace.`)
  return target
}

/** Display path: relative to the workspace root when inside it. */
export function displayPath(ctx: Context, scope: DocScope, target: FsTarget): string {
  const abs = ctx.fs.processPath(target)
  const root = scope.root.replace(/[\\/]+$/, '')
  return abs.startsWith(root + '/') || abs.startsWith(root + '\\') ? abs.slice(root.length + 1) : abs
}
