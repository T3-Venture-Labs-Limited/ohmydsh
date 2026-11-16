// Typed fetch client for the Studio v2 host API (docs/API.md). Same-origin, no polling anywhere.
import type {
  AssetEdge, AssetQuery, AssetRecord, AgentMediaSummary, ChatRef, EstimateResult, HfOpen, HfStatus, JobView, ModelDescriptor, ModelExample, OperationRequest, SpendRow,
} from './types.js'

export const BASE = '/plugins/dsh-studio/v2'

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message?: string) { super(message ?? code) }
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(BASE + path, { credentials: 'same-origin', ...init })
  const text = await response.text()
  let body: unknown
  try { body = text === '' ? undefined : JSON.parse(text) } catch { body = undefined }
  if (!response.ok) {
    const e = (body ?? {}) as { error?: string; message?: string }
    throw new ApiError(response.status, e.error ?? `http-${String(response.status)}`, e.message ?? e.error ?? `Request failed (${String(response.status)})`)
  }
  return body as T
}

const jsonInit = (method: string, body: unknown): RequestInit => ({ method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
const qs = (params: Record<string, string | number | boolean | undefined>): string => {
  const out = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) if (value !== undefined && value !== '' && value !== false) out.set(key, value === true ? '1' : String(value))
  const text = out.toString()
  return text === '' ? '' : `?${text}`
}

export const fileUrl = (id: string): string => `${BASE}/assets/${id}/file`
export const thumbUrl = (id: string, w = 320): string => `${BASE}/assets/${id}/thumb?w=${String(w)}`
export const posterUrl = (id: string): string => `${BASE}/assets/${id}/poster`

export const api = {
  models: (options: { refresh?: boolean } = {}) => call<{ models: ModelDescriptor[] }>(`/models${qs({ refresh: options.refresh })}`),
  providers: () => call<{ providers: { id: string; configured: boolean }[] }>('/providers'),
  examples: (modelId: string) => call<{ available: boolean; examples: ModelExample[] }>(`/models/examples${qs({ modelId })}`),
  estimate: (request: unknown) => call<EstimateResult>('/estimate', jsonInit('POST', request)),
  submit: (request: unknown) => call<{ job: JobView }>('/jobs', jsonInit('POST', request)),
  job: (id: string) => call<{ job: JobView; request: OperationRequest }>(`/jobs/${id}`),
  jobs: (options: { state?: string; limit?: number } = {}) => call<{ jobs: JobView[] }>(`/jobs${qs({ state: options.state, limit: options.limit })}`),
  cancel: (id: string) => call<{ job: JobView }>(`/jobs/${id}/cancel`, { method: 'POST' }),
  retry: (id: string) => call<{ job: JobView }>(`/jobs/${id}/retry`, { method: 'POST' }),

  assets: (query: AssetQuery, page: { limit: number; offset: number }) =>
    call<{ items: AssetRecord[]; total: number }>(`/assets${qs({ ...query, limit: page.limit, offset: page.offset })}`),
  asset: (id: string) => call<{ asset: AssetRecord; parents: AssetEdge[]; children: AssetEdge[]; collections?: string[]; chat?: ChatRef }>(`/assets/${id}`),
  agentMediaStatus: () => call<{ running: boolean; last: AgentMediaSummary | null; count: number }>('/agent-media/status'),
  agentMediaBackfill: () => call<{ summary: AgentMediaSummary }>('/agent-media/backfill', { method: 'POST' }),
  lineage: (id: string) => call<{ nodes: AssetRecord[]; edges: AssetEdge[] }>(`/assets/${id}/lineage`),
  patchAsset: (id: string, patch: { title?: string | null; favorite?: boolean; rating?: number | null; notes?: string | null }) =>
    call<{ asset: AssetRecord }>(`/assets/${id}`, jsonInit('PATCH', patch)),
  deleteAsset: (id: string) => call<{ ok: true }>(`/assets/${id}`, { method: 'DELETE' }),
  tag: (id: string, change: { add?: string[]; remove?: string[] }) => call<{ tags: string[] }>(`/assets/${id}/tags`, jsonInit('POST', change)),
  tags: () => call<{ tags: { tag: string; count: number }[] }>('/tags'),
  collections: () => call<{ collections: { id: string; name: string; count: number }[] }>('/collections'),
  createCollection: (name: string) => call<{ id: string; name: string }>('/collections', jsonInit('POST', { name })),
  toggleCollection: (assetId: string, change: { add?: string; remove?: string }) =>
    call<{ ok: true }>(`/assets/${assetId}/collections`, jsonInit('POST', change)),
  spend: (since: number) => call<{ spend: SpendRow[] }>(`/spend${qs({ since })}`),
  stats: () => call<{ count: number; bytes: number; images: number; videos: number }>('/stats'),
  async importFile(file: Blob, options: { title?: string; tags?: string[] } = {}): Promise<AssetRecord> {
    const response = await fetch(`${BASE}/assets/import${qs({ title: options.title, tags: options.tags?.join(',') })}`, {
      method: 'POST', credentials: 'same-origin', headers: { 'content-type': file.type || 'application/octet-stream' }, body: file,
    })
    const body = await response.json().catch(() => ({})) as { asset?: AssetRecord; error?: string; message?: string }
    if (!response.ok || body.asset === undefined) throw new ApiError(response.status, body.error ?? 'import-failed', body.message ?? 'Import failed')
    return body.asset
  },
  async createMask(png: Blob, source: string): Promise<{ asset: AssetRecord; stats: { width: number; height: number; editedFraction: number } }> {
    const response = await fetch(`${BASE}/masks?source=${encodeURIComponent(source)}`, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'image/png' }, body: png })
    const body = await response.json().catch(() => ({})) as { asset?: AssetRecord; stats?: { width: number; height: number; editedFraction: number }; error?: string; message?: string }
    if (!response.ok || body.asset === undefined || body.stats === undefined) throw new ApiError(response.status, body.error ?? 'mask-failed', body.message ?? 'Could not store the mask')
    return { asset: body.asset, stats: body.stats }
  },
  expand: (body: { assetId: string; top?: number; right?: number; bottom?: number; left?: number; overlap?: number }) =>
    call<{ image: AssetRecord; mask: AssetRecord; width: number; height: number }>('/assets/expand', jsonInit('POST', body)),
  zipUrl: (ids: readonly string[]) => `${BASE}/assets/zip?ids=${ids.join(',')}`,
  async zipBlob(ids: readonly string[]): Promise<Blob> {
    const response = await fetch(`${BASE}/assets/zip`, { ...jsonInit('POST', { ids }), credentials: 'same-origin' })
    if (!response.ok) throw new ApiError(response.status, 'zip-failed', 'ZIP export failed')
    return response.blob()
  },

  hf: {
    status: () => call<HfStatus>('/hyperframes/status'),
    open: (body: { assetIds?: string[]; project?: string }) => call<HfOpen>('/hyperframes/open', jsonInit('POST', body)),
    stop: (slug: string) => call<{ stopped: boolean }>('/hyperframes/stop', jsonInit('POST', { slug })),
    importRenders: (slug: string) => call<{ assets: AssetRecord[] }>('/hyperframes/import-renders', jsonInit('POST', { slug })),
  },
}
