// Typed calls to the host routes (same-origin POST JSON, document-relative so a reverse-proxy prefix keeps working).
// Envelope: { ok: true, value } | { ok: false, error: { code, message } }.
import { API_BASE } from '../shared/types.ts'

/** The session controller's `modelCatalog()` as returned by the `models` route (null when unavailable). */
export interface Catalog {
  default?: { provider: string; model: string; reasoningEffort?: string }
  groups: readonly {
    id: string
    name: string
    models: readonly { id: string; name: string; reasoning?: { efforts: readonly { id: string; name: string }[]; defaultEffort?: string } }[]
  }[]
}

export class ApiError extends Error {
  constructor(readonly code: string, message: string) { super(message) }
}

/** `api/triggers/<method>` relative to the document (API_BASE without its leading slash). */
export const routeUrl = (method: string): string => `${API_BASE.replace(/^\//, '')}/${method}`

export async function call<T>(method: string, body: object = {}): Promise<T> {
  const response = await fetch(routeUrl(method), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  let json: { ok?: boolean; value?: T; error?: { code?: string; message?: string } } | undefined
  try { json = await response.json() as typeof json } catch { /* non-JSON failure below */ }
  if (json?.ok === true) return json.value as T
  throw new ApiError(json?.error?.code ?? `http-${String(response.status)}`, json?.error?.message ?? `Request failed (${String(response.status)})`)
}

export const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e))
