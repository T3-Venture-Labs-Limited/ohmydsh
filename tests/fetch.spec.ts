import { APIConnectionTimeoutError, APIUserAbortError } from 'parallel-web'
import { describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_MAX_FETCH_CHARS,
  ParallelFetchProvider,
  buildExtractBody,
  mapExtractResponse,
  type ExtractClient,
  type ParallelFetchProviderOptions,
} from '../src/fetch.ts'

const baseOptions: ParallelFetchProviderOptions = { apiKey: 'parallel_test_fetch' }
const url = 'https://example.test/page'

function providerWithExtract(extract: ExtractClient['extract'], options: Partial<ParallelFetchProviderOptions> = {}) {
  const factory = vi.fn((): ExtractClient => ({ extract }))
  return { provider: new ParallelFetchProvider({ ...baseOptions, ...options }, factory), factory }
}

const okPayload = (result: Record<string, unknown>) => ({
  results: [{ url, excerpts: [], ...result }],
  errors: [],
  extract_id: 'extract_test',
  session_id: 'session_test',
})

describe('Parallel extract request', () => {
  it('requests full content inside advanced_settings for exactly one URL', () => {
    const body = buildExtractBody({ url })
    expect(body).toEqual({ urls: [url], advanced_settings: { full_content: true } })
    expect('full_content' in body).toBe(false)
  })

  it('passes the URL, abort signal, and redirect-rejecting transport options', async () => {
    const extract = vi.fn().mockResolvedValue(okPayload({ full_content: 'hello' }))
    const { provider } = providerWithExtract(extract)
    const controller = new AbortController()
    await provider.fetch({ url }, controller.signal)
    expect(extract.mock.calls[0]?.[0]).toEqual({ urls: [url], advanced_settings: { full_content: true } })
    expect(extract.mock.calls[0]?.[1]).toEqual({
      signal: controller.signal,
      maxRetries: 0,
      timeout: 60_000,
      fetchOptions: { redirect: 'error' },
    })
  })
})

describe('Parallel extract response mapping', () => {
  it('maps full_content to a text body with the result URL', () => {
    expect(mapExtractResponse(
      okPayload({ url: 'https://example.test/final', title: 'T', full_content: '# Title\n\nbody' }),
      url,
      DEFAULT_MAX_FETCH_CHARS,
    )).toEqual({
      url: 'https://example.test/final',
      statusCode: 200,
      body: { kind: 'text', content: '# Title\n\nbody' },
      truncated: false,
    })
  })

  it('falls back to joined excerpts when full_content is missing or blank', () => {
    for (const full_content of [undefined, null, '  ']) {
      expect(mapExtractResponse(
        okPayload({ full_content, excerpts: ['a', ' ', 'b'] }),
        url,
        DEFAULT_MAX_FETCH_CHARS,
      ).body).toEqual({ kind: 'text', content: 'a\n\nb' })
    }
  })

  it('truncates past the character cap and flags it', () => {
    expect(mapExtractResponse(okPayload({ full_content: 'abcdef' }), url, 4)).toMatchObject({
      body: { kind: 'text', content: 'abcd' },
      truncated: true,
    })
  })

  it('errors when a result has no content at all', () => {
    expect(() => mapExtractResponse(okPayload({ full_content: null, excerpts: [] }), url, 10))
      .toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR' }))
  })

  it('maps an errors[] entry to WEB_PROVIDER_ERROR naming type and status', () => {
    const payload = {
      results: [],
      errors: [{ url, error_type: 'fetch_error', http_status_code: 404, content: 'Not found' }],
    }
    expect(() => mapExtractResponse(payload, url, 10)).toThrow(
      expect.objectContaining({
        code: 'WEB_PROVIDER_ERROR',
        message: expect.stringContaining('fetch_error, HTTP 404'),
      }),
    )
  })

  it('errors when neither results nor errors describe the URL', () => {
    expect(() => mapExtractResponse({ results: [], errors: [] }, url, 10))
      .toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR' }))
  })

  it.each([{}, { results: {} }, { results: [null] }])('rejects malformed payload %#', payload => {
    expect(() => mapExtractResponse(payload, url, 10)).toThrow(TypeError)
  })
})

describe('Parallel fetch provider behaviour', () => {
  it('is available only with a key and a valid cap, and ready follows', async () => {
    expect(new ParallelFetchProvider(baseOptions).available()).toBe(true)
    await expect(new ParallelFetchProvider(baseOptions).ready()).resolves.toBe(true)
    const noKey = new ParallelFetchProvider({ apiKey: '' })
    expect(noKey.available()).toBe(false)
    await expect(noKey.ready('anything')).resolves.toBe(false)
    expect(new ParallelFetchProvider({ ...baseOptions, maxFetchChars: 0 }).available()).toBe(false)
  })

  it('wraps an errors[] outcome from the real response path', async () => {
    const { provider } = providerWithExtract(vi.fn().mockResolvedValue({
      results: [],
      errors: [{ url, error_type: 'timeout', http_status_code: null, content: null }],
    }))
    await expect(provider.fetch({ url })).rejects.toMatchObject({ code: 'WEB_PROVIDER_ERROR' })
  })

  it.each([
    ['http://', 'WEB_INVALID_URL'],
    ['ftp://example.test/x', 'WEB_INVALID_URL'],
    ['https://user:pw@example.test/', 'WEB_BLOCKED_URL'],
    [`https://example.test/${'a'.repeat(2100)}`, 'WEB_INVALID_URL'],
  ])('rejects URL %#', async (bad, code) => {
    const extract = vi.fn()
    const { provider, factory } = providerWithExtract(extract)
    await expect(provider.fetch({ url: bad })).rejects.toMatchObject({ code })
    expect(factory).not.toHaveBeenCalled()
  })

  it('rejects a pre-aborted request without constructing a client', async () => {
    const { provider, factory } = providerWithExtract(vi.fn())
    const controller = new AbortController()
    controller.abort()
    await expect(provider.fetch({ url }, controller.signal)).rejects.toMatchObject({ code: 'WEB_ABORTED' })
    expect(factory).not.toHaveBeenCalled()
  })

  it('maps the SDK user-abort class and an in-flight abort to WEB_ABORTED', async () => {
    const { provider } = providerWithExtract(vi.fn().mockRejectedValue(new APIUserAbortError()))
    await expect(provider.fetch({ url })).rejects.toMatchObject({ code: 'WEB_ABORTED' })

    const controller = new AbortController()
    const extract = vi.fn(() => new Promise<never>((_resolve, reject) => {
      controller.signal.addEventListener('abort', () => reject(new Error('stopped')), { once: true })
    }))
    const pending = providerWithExtract(extract).provider.fetch({ url }, controller.signal)
    controller.abort()
    await expect(pending).rejects.toMatchObject({ code: 'WEB_ABORTED' })
  })

  it('maps an SDK timeout and a network failure to WEB_PROVIDER_ERROR with the cause', async () => {
    const timeout = new APIConnectionTimeoutError()
    await expect(providerWithExtract(vi.fn().mockRejectedValue(timeout)).provider.fetch({ url }))
      .rejects.toMatchObject({ code: 'WEB_PROVIDER_ERROR', cause: timeout })
    const net = new TypeError('connection refused')
    await expect(providerWithExtract(vi.fn().mockRejectedValue(net)).provider.fetch({ url }))
      .rejects.toMatchObject({ code: 'WEB_PROVIDER_ERROR', cause: net })
  })

  it.each([
    [401, 'rejected the API key'],
    [403, 'rejected the API key'],
    [422, 'invalid'],
    [429, 'rate limit'],
    [500, 'unavailable'],
    [503, 'unavailable'],
  ])('maps HTTP %i to WEB_PROVIDER_ERROR', async (status, text) => {
    const error = Object.assign(new Error(`HTTP ${status}`), { status })
    await expect(providerWithExtract(vi.fn().mockRejectedValue(error)).provider.fetch({ url }))
      .rejects.toMatchObject({
        code: 'WEB_PROVIDER_ERROR',
        message: expect.stringContaining(text),
        cause: error,
      })
  })

  it('does not copy a rejected error message containing the key', async () => {
    const key = 'parallel_test_must_not_leak'
    const { provider } = providerWithExtract(vi.fn().mockRejectedValue(new Error(`bad ${key}`)), { apiKey: key })
    let caught: unknown
    try {
      await provider.fetch({ url })
    } catch (error: unknown) {
      caught = error
    }
    expect(caught).toMatchObject({ code: 'WEB_PROVIDER_ERROR' })
    expect(String(caught)).not.toContain(key)
  })

  it('wraps malformed success data as WEB_PROVIDER_ERROR', async () => {
    const { provider } = providerWithExtract(vi.fn().mockResolvedValue({ results: {} }))
    await expect(provider.fetch({ url })).rejects.toMatchObject({ code: 'WEB_PROVIDER_ERROR' })
  })
})
