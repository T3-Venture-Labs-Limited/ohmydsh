// Typed calls to the host routes (same-origin POST JSON, document-relative so a reverse-proxy prefix keeps working).
export interface Route { provider: string; model: string; reasoningEffort?: string }
export interface Account { id?: string; wordId: string; alias: string | null; displayName?: string | null; status: string }
export interface Toolkit { slug: string; name: string; logo?: string | null; accounts: Account[]; hasExpired: boolean }
export interface Recipe {
  id: string; name: string; promptTemplate: string; cwd?: string; agentPreset?: string; model: Route | null
  allowToolkits: string[]; allowTools: string[]; sandbox: 'read-only' | 'workspace-write'; payload: { maxChars?: number; include?: string[] }
  sessionTitle?: string; createdAt: number; updatedAt: number
}
export interface TriggerRoute {
  id: string; name: string; enabled: boolean; triggerSlug: string; toolkit: string; connectedAccountId: string; triggerConfig: Record<string, unknown>
  triggerInstanceId: string; recipeId: string; target: { mode: 'new-session' } | { mode: 'existing-session'; sessionId: string; acknowledged?: boolean }
  consecutiveFailures: number; createdAt: number
}
export interface Run {
  runId: string; at: number; routeId: string; routeName: string; recipeId: string; mode: string; event: { id: string; slug: string; toolkit: string; bytes: number }
  status: string; reason?: string; sessionId?: string; model?: string; error?: string
}
export interface State {
  health: { ok: boolean; email?: string; org?: string; error?: string }
  listener: { state: string; lastEventAt: number | null; lastError: string | null }
  paused: boolean; queued: number; hasAutomationModels: boolean
  connections: Toolkit[] | null; recipes: Recipe[]; routes: TriggerRoute[]; orphanTriggers: { id: string; slug: string }[]; runs: Run[]
}
export interface ToolSummary { slug: string; name: string; description: string; toolkit: string; risk: 'read' | 'write' | 'destructive' | 'unknown' }
export interface TriggerType { slug: string; name: string; description: string; type: string; instructions: string; config: unknown }
export interface Catalog { groups: { id: string; name: string; models: { id: string; name: string; reasoning?: { efforts: { id: string; name: string }[] } }[] }[] }

export class ApiError extends Error { constructor(readonly code: string, message: string) { super(message) } }

export async function call<T>(method: string, body: Record<string, unknown> = {}): Promise<T> {
  const response = await fetch(`api/composio/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  let json: { ok?: boolean; value?: T; error?: { code?: string; message?: string } } | undefined
  try { json = await response.json() as typeof json } catch { /* non-JSON failure below */ }
  if (json?.ok === true) return json.value as T
  throw new ApiError(json?.error?.code ?? `http-${String(response.status)}`, json?.error?.message ?? `Request failed (${String(response.status)})`)
}
