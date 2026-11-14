/**
 * Execution approval. Notebook cells run arbitrary code on the host without the shell sandbox, so a model-driven
 * run is gated like a command: ask the user unless the session already runs in full-access mode.
 * (`approval: never` in the session policy makes the ask resolve as rejected, which is the safe default for
 * unattended runs.) A human clicking Run in the sidebar is not gated: they are the one executing.
 */
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { PreToolDecision, ToolExecution } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import { parseCellRefs } from '../core/text.ts'
import type { NotebookService } from './service.ts'
import { scopeOfSession } from './scope.ts'
import type { Settings } from './settings.ts'
import { EXECUTING_TOOLS } from './tools.ts'

const PREVIEW_CHARS = 300
const PREVIEW_CELLS = 8

/** Capped, human-readable preview of the code a run will execute, plus a digest of the full selection. */
export function previewCells(cells: { id: string; cell_type: string; source: string }[], ids: string[]): string {
  const picked = ids.map((id) => cells.find((c) => c.id === id)).filter((c): c is { id: string; cell_type: string; source: string } => c !== undefined && c.cell_type === 'code')
  const digest = createHash('sha256').update(picked.map((c) => c.source).join('\n\u0000\n')).digest('hex').slice(0, 12)
  const shown = picked.slice(0, PREVIEW_CELLS).map((c) => {
    const index = cells.findIndex((x) => x.id === c.id)
    const text = c.source.length > PREVIEW_CHARS ? `${c.source.slice(0, PREVIEW_CHARS)}… (+${c.source.length - PREVIEW_CHARS} chars)` : c.source
    return `[${index}] ${text}`
  })
  const more = picked.length > PREVIEW_CELLS ? `\n… and ${picked.length - PREVIEW_CELLS} more code cell(s)` : ''
  return `${shown.join('\n---\n')}${more}\n(sha256 ${digest}, ${picked.length} code cell(s))`
}

interface DescribeInput { exec: ToolExecution; preview?: string | undefined; interpreter?: string | undefined }

function describe({ exec, preview, interpreter }: DescribeInput): { en: string; reason: string } {
  const args = (exec.arguments ?? {}) as { path?: string; cells?: string; action?: string; packages?: string[]; python?: string }
  if (exec.name === 'nb_env') {
    const target = interpreter ?? args.python
    const what = args.action === 'create'
      ? `create a Python environment${target === undefined ? '' : ` at ${target}`}${args.packages?.length ? ` and install ${args.packages.join(', ')}` : ''}`
      : `switch the notebook interpreter to ${target ?? '(unspecified)'} (it will be executed by every cell run)`
    const text = `The agent wants to ${what}${args.path === undefined ? '' : ` for ${args.path}`}.`
    return { en: text, reason: text }
  }
  const head = `The agent wants to run ${args.cells === undefined || args.cells === 'all' ? 'all cells' : `cells ${args.cells}`} of ${args.path ?? 'a notebook'}. Notebook code runs on this machine outside the sandbox.`
  const text = preview === undefined || preview === '' ? head : `${head}\n\nCode to run:\n${preview}`
  return { en: text, reason: text }
}

export function registerApproval(ctx: Context, settings: Settings, service?: NotebookService): () => void {
  return ctx.on('tools/pre-execute', async (exec, next): Promise<PreToolDecision> => {
    if (!EXECUTING_TOOLS.has(exec.name) || exec.agent === undefined) return next()
    // nb_env list is a passive filesystem scan (NB-1): it never executes a candidate interpreter.
    if (exec.name === 'nb_env' && (exec.arguments as { action?: string } | undefined)?.action === 'list') return next()
    if (settings.approval === 'never') return next()
    if (settings.approval === 'auto') {
      const mode = ctx.sandboxPolicy.resolve({ session: exec.agent.session }).mode
      if (mode === 'danger-full-access') return next()
    }
    // What will actually run goes into the prompt: the code of the selected cells, or the interpreter path.
    let preview: string | undefined
    let interpreter: string | undefined
    try {
      const args = (exec.arguments ?? {}) as { path?: string; cells?: string; action?: string; python?: string }
      if (service !== undefined && typeof args.path === 'string') {
        let base: string | undefined
        try { base = await ctx.get('workingDirectory')?.ensure(exec.agent, exec.signal) } catch { base = undefined }
        const scope = await scopeOfSession(ctx, exec.agent.session.id, { base })
        const doc = await service.open(scope, args.path, { create: false })
        if (exec.name === 'nb_run') preview = previewCells(doc.cells, parseCellRefs(args.cells, doc.cells.map((c) => c.id)))
        else if (args.action === 'create') interpreter = join(dirname(ctx.fs.processPath(doc.target)), '.venv', 'bin', 'python')
      }
    } catch { /* fall back to the generic prompt: a notebook that cannot be read cannot be run either */ }
    const { en, reason } = describe({ exec, preview, interpreter })
    return { kind: 'ask', reason, displayReason: { en } }
  })
}
