// Typed calls to the host routes (same-origin POST JSON, document-relative like the other plugins' routes).
import type { Issue } from '../host/frontmatter.ts'
import type { SkillRow } from '../host/model.ts'
import type { Settings } from '../host/store.ts'

export type { Issue, SkillRow, Settings }

export interface WorkspaceInfo { id: string; title: string; path: string; root: string }
export interface StateResult {
  rows: SkillRow[]
  workspaces: WorkspaceInfo[]
  projectRoot: string | null
  roots: { path: string; source: string }[]
  filter: { installed: boolean; reason?: string }
  settings: Settings
  usage: { cached: boolean; sessionsScanned: number }
  registry: boolean
  dshHome: string
  agentsHome: string
  createRoots: Record<string, string>
}
export interface ReadResult { id: string; path: string; realPath: string; text: string; sha256: string; editable: boolean; readOnlyReason: 'system' | 'permission' | 'outside-root' | null; issues: Issue[]; wouldLoad: boolean }
export interface SaveResult { sha256: string; backup: string; mtimeMs: number; issues: Issue[]; wouldLoad: boolean }
export interface ValidateResult { wouldLoad: boolean; issues: Issue[]; name: string | null; description: string | null; modelInvocable: boolean; userInvocable: boolean }

export class ApiError extends Error {
  constructor(readonly code: string, message: string, readonly issues?: Issue[]) { super(message) }
}

export async function call<T>(method: string, body: Record<string, unknown> = {}, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`api/skill-studio/${method}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), ...(signal === undefined ? {} : { signal }),
  })
  let json: { ok?: boolean; value?: T; error?: { code?: string; message?: string; issues?: Issue[] } } | undefined
  try { json = await response.json() as typeof json } catch { /* non-JSON failure below */ }
  if (json?.ok === true) return json.value as T
  throw new ApiError(json?.error?.code ?? `http-${String(response.status)}`, json?.error?.message ?? `Request failed (${String(response.status)})`, json?.error?.issues)
}

// ---- evolution
import type { Proposal } from '../host/proposals.ts'
import type { EvolutionConfig } from '../host/evolution-config.ts'
import type { RunLog } from '../host/reviewer.ts'
export type { Proposal, EvolutionConfig, RunLog }

export interface ProposalsResult { proposals: Proposal[]; pending: number; target: string }
export interface ConfigResult { config: EvolutionConfig; route: { provider: string; model: string; effort?: string }; automation: boolean; defaults: EvolutionConfig }
export interface ReviewStateResult { runs: RunLog[]; tokensToday: number; running: boolean; lastSweepAt: number; budget: number }
export interface Summary { pending: number; sessions: string[]; reviewing: boolean }
