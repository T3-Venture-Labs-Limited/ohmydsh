import { afterEach, describe, expect, it, vi } from 'vitest'
import { describeTransportFailure, guardedFetch } from '../src/fetch-diagnostics.js'
import { editOpenAICompatibleImage, generateOpenAICompatibleImage } from '../src/openai-compatible.js'
import { generateGoogleImage } from '../src/google.js'

afterEach(() => { vi.unstubAllGlobals() })
const signal = new AbortController().signal

/** Shape undici produces for a socket-level failure: TypeError with the real reason on `cause`. */
function socketFailure(message = 'other side closed'): TypeError {
  const cause = Object.assign(new Error(message), { code: 'UND_ERR_SOCKET' })
  return new TypeError('fetch failed', { cause })
}

describe('describeTransportFailure', () => {
  it('renders the error plus its cause chain with codes', () => {
    expect(describeTransportFailure(socketFailure())).toBe('TypeError: fetch failed <- Error [UND_ERR_SOCKET]: other side closed')
  })

  it('prefers the signal reason once the caller aborted', () => {
    const controller = new AbortController()
    controller.abort(new Error('upstream budget expired'))
    expect(describeTransportFailure(socketFailure(), controller.signal)).toBe('aborted (Error: upstream budget expired)')
  })

  it('keeps non-Error abort reasons as text', () => {
    const controller = new AbortController()
    controller.abort('user closed the panel')
    expect(describeTransportFailure(socketFailure(), controller.signal)).toBe('aborted (user closed the panel)')
  })

  it('names the default AbortError for plain cancels', () => {
    const controller = new AbortController()
    controller.abort()
    expect(describeTransportFailure(controller.signal.reason, controller.signal)).toBe('aborted (AbortError: This operation was aborted)')
  })

  it('caps the cause-chain walk at three levels', () => {
    const deepest = new Error('level 4')
    const third = new Error('level 3', { cause: deepest })
    const second = new Error('level 2', { cause: third })
    const first = new Error('level 1', { cause: second })
    expect(describeTransportFailure(first)).toBe('Error: level 1 <- Error: level 2 <- Error: level 3')
  })

  it('falls back for non-error throwables', () => {
    expect(describeTransportFailure(undefined)).toBe('unknown transport error')
    expect(describeTransportFailure(42)).toBe('42')
  })
})

describe('guardedFetch transport diagnostics (#79)', () => {

  it('keeps the original error reachable on cause', async () => {
    const original = socketFailure()
    vi.stubGlobal('fetch', vi.fn(async () => { throw original }))
    const rejection: Error = await generateOpenAICompatibleImage({ provider: 'openai', apiKey: 'key', baseURL: 'https://api.openai.com/v1', model: 'gpt-image-2', prompt: 'a cat', maxBytes: 1024, signal })
      .then(() => { throw new Error('expected a rejection') }, error => error)
    expect(rejection.cause).toBe(original)
  })

  it('redacts key-shaped values leaking through cause messages', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw socketFailure('connect failed for token sk-abcdefghijklmnop1234') }))
    await expect(guardedFetch('openai image request', signal, () => fetch('https://api.openai.com/v1/images/generations')))
      .rejects.toThrow(/\[REDACTED\]/)
  })

  it('redacts URL credentials that Node echoes when it refuses a URL with userinfo (#114)', async () => {
    // Node's own refusal, reproduced without network: the message carries the whole URL.
    const nodeRefusal = (url: string) => new TypeError(`Request cannot be constructed from a URL that includes credentials: ${url}`)
    for (const url of ['https://user:password@cdn.example/image', '//user:password@cdn.example/image', 'https://tok3n-secret@relay.example/v1/images']) {
      vi.stubGlobal('fetch', vi.fn(async () => { throw nodeRefusal(url) }))
      const failure = await guardedFetch('openai-compat image download', signal, () => fetch('https://cdn.example/image')).catch((error: unknown) => error as Error)
      expect(failure.message).not.toMatch(/password|tok3n-secret/)
      expect(failure.message).toContain('//[REDACTED]@')
    }
    // Redaction runs before truncation, so a long URL cannot leave half a password behind.
    vi.stubGlobal('fetch', vi.fn(async () => { throw nodeRefusal(`https://user:${'p'.repeat(40)}secretTail@cdn.example/${'x'.repeat(2000)}`) }))
    const long = await guardedFetch('openai-compat image download', signal, () => fetch('https://cdn.example/image')).catch((error: unknown) => error as Error)
    expect(long.message).not.toContain('secretTail')
  })

  it('leaves successful fetches untouched', async () => {
    const response = new Response('{}', { headers: { 'content-type': 'application/json' } })
    const fetchMock = vi.fn(async () => response)
    vi.stubGlobal('fetch', fetchMock)
    await expect(guardedFetch('openai image request', signal, () => fetch('https://api.openai.com/v1/images/generations'))).resolves.toBe(response)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

const opaqueKey = 'fixture-5f811fea-d938-46d7-9a47-07148cc510db'
const compatibleInput = { provider: 'openai-compat' as const, apiKey: opaqueKey, baseURL: 'https://relay.example/v1', model: 'relay-image', prompt: 'a cat', maxBytes: 1024, signal }
const editInput = { ...compatibleInput, sourceImages: [{ data: new Uint8Array([1]), mediaType: 'image/png' as const }] }
const requestCases = [
  { label: 'openai-compat image request', run: () => generateOpenAICompatibleImage(compatibleInput) },
  { label: 'openai image edit request', run: () => editOpenAICompatibleImage(editInput) },
  { label: 'Google image generation request', run: () => generateGoogleImage({ apiKey: opaqueKey, endpoint: 'https://google.example/interactions', model: 'gemini-image', prompt: 'a cat', aspectRatio: '1:1', imageSize: '2K', maxBytes: 1024, signal }) },
]

/** A response that delivers a partial chunk, then loses its connection after headers. */
function brokenBody(contentType: string, error: unknown = new TypeError('terminated', { cause: Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' }) })): Response {
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new Uint8Array([1, 2, 3])) },
    pull(controller) { controller.error(error) },
  }), { headers: { 'content-type': contentType } })
}

describe('complete provider transport diagnostics (#79 regressions)', () => {
  it.each(requestCases)('reports $label response-body disconnects', async ({ label, run }) => {
    vi.stubGlobal('fetch', vi.fn(async () => brokenBody('application/json')))
    const error: Error = await run().then(() => { throw new Error('expected failure') }, error => error)
    expect(error.message).toContain(`${label} failed after `)
    expect(error.message).toContain('TypeError: terminated <- Error [UND_ERR_SOCKET]: other side closed')
    expect(error.cause).toBeInstanceOf(TypeError)
  })

  it.each(requestCases)('redacts the actual opaque key in $label fetch errors', async ({ run }) => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw socketFailure(`fixture rejected credential ${opaqueKey}`) }))
    const error: Error = await run().then(() => { throw new Error('expected failure') }, error => error)
    expect(error.message).not.toContain(opaqueKey)
    expect(error.message).toContain('[REDACTED]')
  })

  it.each(requestCases)('redacts the actual opaque key in $label body errors', async ({ run }) => {
    vi.stubGlobal('fetch', vi.fn(async () => brokenBody('application/json', socketFailure(`fixture rejected credential ${opaqueKey}`))))
    const error: Error = await run().then(() => { throw new Error('expected failure') }, error => error)
    expect(error.message).not.toContain(opaqueKey)
    expect(error.message).toContain('[REDACTED]')
  })

  it.each([
    { reason: { kind: 'user' }, text: 'aborted (user)' },
    { reason: { kind: 'parent' }, text: 'aborted (parent)' },
    { reason: { kind: 'disposed' }, text: 'aborted (disposed)' },
    { reason: { kind: 'hook', reason: 'execution window expired' }, text: 'aborted (hook: execution window expired)' },
  ])('preserves the host cancellation reason $reason.kind', ({ reason, text }) => {
    const controller = new AbortController()
    controller.abort(reason)
    expect(describeTransportFailure(reason, controller.signal)).toBe(text)
  })

  it('reports structured cancellation during body consumption and redacts its reason', async () => {
    const controller = new AbortController()
    const reason = { kind: 'hook', reason: `fixture rejected credential ${opaqueKey}` }
    vi.stubGlobal('fetch', vi.fn(async () => {
      controller.abort(reason)
      return brokenBody('application/json', reason)
    }))
    const error: Error = await generateOpenAICompatibleImage({ ...compatibleInput, signal: controller.signal })
      .then(() => { throw new Error('expected failure') }, error => error)
    expect(error.message).toContain('aborted (hook: fixture rejected credential [REDACTED])')
    expect(error.message).not.toContain(opaqueKey)
    expect(error.cause).toBe(reason)
  })

  it('bounds cyclic structured cancellation reasons', async () => {
    const reason: { kind: string; reason?: unknown } = { kind: 'hook' }
    reason.reason = reason
    const controller = new AbortController()
    controller.abort(reason)
    vi.stubGlobal('fetch', vi.fn(async () => { throw reason }))
    const error: Error = await generateOpenAICompatibleImage({ ...compatibleInput, signal: controller.signal })
      .then(() => { throw new Error('expected failure') }, error => error)
    expect(error.message).toContain('aborted (hook:')
    expect(error.message.length).toBeLessThan(700)
  })

  it('preserves the existing response size-limit error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('x'.repeat(5000))))
    await expect(generateOpenAICompatibleImage({ ...compatibleInput, maxBytes: 1 }))
      .rejects.toThrow(/^Image response exceeded the 4098 byte limit$/)
  })
})
