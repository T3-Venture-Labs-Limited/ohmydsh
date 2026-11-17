import Parallel, { APIUserAbortError, type Parallel as ParallelTypes } from 'parallel-web'
import { WebError } from '@deepseek-ai/dsh-web'
import type { WebFetchProvider, WebFetchRequest, WebFetchResult } from '@deepseek-ai/dsh-web'
import { PARALLEL_API_ORIGIN, PARALLEL_PROVIDER_ID } from './provider.ts'

export const DEFAULT_MAX_FETCH_CHARS = 100_000
export const MAX_URL_LENGTH = 2048

export interface ParallelFetchProviderOptions {
  apiKey: string
  /** Decoded-body cap in characters; the provider truncates past it. */
  maxFetchChars?: number
}

export interface ExtractClient {
  extract(body: ParallelTypes.ExtractParams, options: ParallelTypes.RequestOptions): PromiseLike<unknown>
}

export type ExtractClientFactory = (apiKey: string) => ExtractClient

const createProductionClient: ExtractClientFactory = apiKey => new Parallel({
  apiKey,
  baseURL: PARALLEL_API_ORIGIN,
})

/**
 * Parallel Extract-backed fetch provider. Parallel retrieves the page server-side
 * (so it cannot reach intranet or local addresses) and returns markdown. The SDK
 * client is created lazily so an unavailable provider never builds a
 * credential-bearing client.
 */
export class ParallelFetchProvider implements WebFetchProvider {
  readonly id = PARALLEL_PROVIDER_ID
  readonly title = 'Parallel Extract'
  readonly description: NonNullable<WebFetchProvider['description']> = {
    en: "Fetches pages as markdown through Parallel's Extract API. Cannot reach intranet or local addresses. Incurs Parallel usage charges.",
  }
  private client: ExtractClient | undefined

  constructor(
    private readonly options: ParallelFetchProviderOptions,
    private readonly createClient: ExtractClientFactory = createProductionClient,
  ) {}

  available(): boolean {
    return this.options.apiKey.length > 0
      && (this.options.maxFetchChars === undefined || isPositiveInteger(this.options.maxFetchChars))
  }

  async ready(_llmProvider?: string): Promise<boolean> {
    return this.available()
  }

  async fetch(request: WebFetchRequest, signal?: AbortSignal): Promise<WebFetchResult> {
    if (signal?.aborted) throw abortedError()
    validateUrl(request.url)

    let payload: unknown
    try {
      payload = await this.getClient().extract(buildExtractBody(request), {
        signal,
        maxRetries: 0,
        timeout: 60_000,
        fetchOptions: { redirect: 'error' },
      })
    } catch (error: unknown) {
      if (signal?.aborted || error instanceof APIUserAbortError) throw abortedError(error)
      throw httpError(error)
    }

    try {
      return mapExtractResponse(payload, request.url, this.options.maxFetchChars ?? DEFAULT_MAX_FETCH_CHARS)
    } catch (error: unknown) {
      if (error instanceof WebError) throw error
      throw new WebError('Parallel returned an invalid extract response', 'WEB_PROVIDER_ERROR', { cause: error })
    }
  }

  private getClient(): ExtractClient {
    return this.client ??= this.createClient(this.options.apiKey)
  }
}

/** `full_content` must sit inside `advanced_settings` on /v1; top-level placement is a 422. */
export function buildExtractBody(request: WebFetchRequest): ParallelTypes.ExtractParams {
  return {
    urls: [request.url],
    advanced_settings: { full_content: true },
  }
}

export function mapExtractResponse(payload: unknown, requestUrl: string, maxChars: number): WebFetchResult {
  if (!isRecord(payload) || !Array.isArray(payload.results)) {
    throw new TypeError('response.results must be an array')
  }
  const results = payload.results
  const errors = Array.isArray(payload.errors) ? payload.errors : []

  const first: unknown = results[0]
  if (first === undefined) {
    throw extractFailure(errors[0], requestUrl)
  }
  if (!isRecord(first)) throw new TypeError('each result must be an object')

  const content = resultContent(first)
  if (content === undefined) {
    throw new WebError('Parallel returned no content for the URL', 'WEB_PROVIDER_ERROR')
  }
  const url = typeof first.url === 'string' && first.url.trim().length > 0 ? first.url : requestUrl
  const truncated = content.length > maxChars
  return {
    url,
    statusCode: 200,
    body: { kind: 'text', content: truncated ? content.slice(0, maxChars) : content },
    truncated,
  }
}

function resultContent(result: Record<string, unknown>): string | undefined {
  if (typeof result.full_content === 'string' && result.full_content.trim().length > 0) {
    return result.full_content
  }
  if (Array.isArray(result.excerpts)) {
    const excerpts = result.excerpts.filter((e): e is string => typeof e === 'string' && e.trim().length > 0)
    if (excerpts.length > 0) return excerpts.join('\n\n')
  }
  return undefined
}

/** Build the WebError for a URL that Parallel reported in `errors[]` instead of `results[]`. */
function extractFailure(entry: unknown, requestUrl: string): WebError {
  if (!isRecord(entry)) {
    return new WebError('Parallel returned neither a result nor an error for the URL', 'WEB_PROVIDER_ERROR')
  }
  const type = typeof entry.error_type === 'string' && entry.error_type.length > 0 ? entry.error_type : 'unknown'
  const status = typeof entry.http_status_code === 'number' ? entry.http_status_code : undefined
  const detail = status === undefined ? type : `${type}, HTTP ${status}`
  return new WebError(`Parallel could not extract ${requestUrl} (${detail})`, 'WEB_PROVIDER_ERROR', {
    cause: entry,
  })
}

function httpError(error: unknown): WebError {
  const status = isRecord(error) && typeof error.status === 'number' ? error.status : undefined
  let message = 'Parallel extract request failed'
  if (status === 401 || status === 403) message = `Parallel rejected the API key (HTTP ${status})`
  else if (status === 422) message = 'Parallel rejected the extract request as invalid (HTTP 422)'
  else if (status === 429) message = 'Parallel rate limit or quota exceeded (HTTP 429)'
  else if (status !== undefined && status >= 500) message = `Parallel is unavailable (HTTP ${status})`
  else if (status !== undefined) message = `Parallel extract request failed (HTTP ${status})`
  return new WebError(message, 'WEB_PROVIDER_ERROR', { cause: error })
}

function validateUrl(input: string): void {
  if (input.length > MAX_URL_LENGTH) {
    throw new WebError(`URL exceeds the maximum length of ${MAX_URL_LENGTH}`, 'WEB_INVALID_URL')
  }
  let url: URL
  try {
    url = new URL(input)
  } catch (error: unknown) {
    throw new WebError('invalid URL', 'WEB_INVALID_URL', { cause: error })
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new WebError(`unsupported URL scheme "${url.protocol}" (only http and https are allowed)`, 'WEB_INVALID_URL')
  }
  if (url.username !== '' || url.password !== '') {
    throw new WebError('credentials in URLs are not allowed', 'WEB_BLOCKED_URL')
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isPositiveInteger(value: number): boolean {
  return Number.isInteger(value) && value > 0
}

function abortedError(cause?: unknown): WebError {
  return new WebError('Parallel fetch aborted', 'WEB_ABORTED', cause === undefined ? {} : { cause })
}
