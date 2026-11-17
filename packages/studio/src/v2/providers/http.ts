/** Small HTTP helpers shared by adapters: error classification, JSON bodies, data URLs. */
import { AdapterError } from '../contracts.js'
import { redactSecrets } from '../../redact.js'

export function toDataUrl(bytes: Uint8Array, mediaType: string): string { return `data:${mediaType};base64,${Buffer.from(bytes).toString('base64')}` }

/** Classify an HTTP failure. 5xx/429 are retryable (provider proved it did not accept the work); 401/403 need attention. */
export function classifyHttp(status: number, body: string, secrets: readonly string[] = []): AdapterError {
  const detail = redactSecrets(extractMessage(body), ...secrets).slice(0, 300)
  const base = `HTTP ${String(status)}${detail.length > 0 ? `: ${detail}` : ''}`
  if (status === 401 || status === 403) return new AdapterError('auth', `Authentication failed (${base})`, { status })
  if (status === 402) return new AdapterError('quota', `Insufficient credits (${base})`, { status })
  if (status === 429) return new AdapterError('quota', `Rate limited (${base})`, { status, retryable: true })
  if (status === 408 || status === 504) return new AdapterError('timeout', base, { status, retryable: true })
  if (status >= 500) return new AdapterError('unavailable', base, { status, retryable: true })
  if (/moderat|safety|policy|blocked|content[_ -]?filter/i.test(detail)) return new AdapterError('moderation', base, { status })
  return new AdapterError('invalid', base, { status })
}

function extractMessage(body: string): string {
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string } | string; message?: string; detail?: string }
    if (typeof parsed.error === 'string') return parsed.error
    return parsed.error?.message ?? parsed.message ?? parsed.detail ?? body
  } catch { return body }
}

export async function jsonRequest(fetchFn: typeof fetch, url: string, init: RequestInit & { secrets?: readonly string[] }): Promise<{ status: number; json: unknown; headers: Headers }> {
  const { secrets, ...rest } = init
  let response: Response
  try { response = await fetchFn(url, { redirect: 'error', ...rest }) } catch (error) {
    if (init.signal?.aborted === true) throw error
    // No status: the request may or may not have reached the provider, so the runner will not retry it.
    throw new AdapterError('unavailable', `Network error calling ${new URL(url).host}: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
  }
  const text = await response.text()
  if (!response.ok) throw classifyHttp(response.status, text, secrets ?? [])
  let json: unknown = {}
  if (text.length > 0) { try { json = JSON.parse(text) } catch { throw new AdapterError('invalid', `${new URL(url).host} returned a non-JSON body`, { status: response.status }) } }
  return { status: response.status, json, headers: response.headers }
}

export const asRecord = (v: unknown): Record<string, unknown> => (typeof v === 'object' && v !== null && !Array.isArray(v) ? v as Record<string, unknown> : {})
export const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])
export const asString = (v: unknown): string | undefined => (typeof v === 'string' && v.length > 0 ? v : undefined)
export const asNumber = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
