// Typed calls to the host routes (same-origin POST JSON, document-relative so a reverse-proxy prefix keeps working).
export interface Route { provider: string; model: string; reasoningEffort?: string }
export type Mode = 'inherit' | 'session' | 'route'
export interface CatalogModel { id: string; name: string; efforts: { id: string; name: string }[]; defaultEffort: string | null }
export interface CatalogGroup { id: string; name: string; models: CatalogModel[] }
export interface SourceRow { kind: string; label: string; builtin: boolean; stored: Mode; route: Route | null; pluginDefault: Route | null; effective: Route | null; effectiveAvailable: boolean }
export interface TaskRow { id: string; title: string; status: string; timing: string; target: string; override: Mode; route: Route | null; keep: boolean }
export interface Notice { at: number; level: 'info' | 'warn'; text: string }
export interface State {
  enabled: boolean; ready: boolean; builtinDefault: Route; sessionDefault: Route | null
  sources: SourceRow[]; tasks: TaskRow[]; catalog: { groups: CatalogGroup[] } | null; notices: Notice[]
}

export class ApiError extends Error { constructor(readonly code: string, message: string) { super(message) } }

export async function call<T>(method: string, body: Record<string, unknown> = {}, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`api/automation-models/${method}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), ...(signal === undefined ? {} : { signal }),
  })
  let json: { ok?: boolean; value?: T; error?: { code?: string; message?: string } } | undefined
  try { json = await response.json() as typeof json } catch { /* non-JSON failure below */ }
  if (json?.ok === true) return json.value as T
  throw new ApiError(json?.error?.code ?? `http-${String(response.status)}`, json?.error?.message ?? `Request failed (${String(response.status)})`)
}
