import { afterEach, describe, expect, it, vi } from 'vitest'
import { AdapterError, type AdapterContext, type OperationRequest } from '../../src/v2/contracts.js'
import { CompatAdapter, ComfyUIAdapter, SubscriptionAdapter } from '../../src/v2/providers/legacy.js'

const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
const PNG = Uint8Array.from(Buffer.from(PNG_B64, 'base64'))
const ctx = (): AdapterContext => ({ signal: new AbortController().signal, fetch, readInput: async () => ({ bytes: PNG, mediaType: 'image/png' }) })
const req = (patch: Partial<OperationRequest> = {}): OperationRequest => ({ op: 'generate', modelId: '', prompt: 'a boat', inputs: {}, params: {}, ...patch })
afterEach(() => vi.unstubAllGlobals())

describe('OpenAI-compatible adapter (legacy port)', () => {
  const adapter = new CompatAdapter('openai-compat', () => [{ id: 'relay', label: 'My relay', baseURL: 'https://relay.example/v1', apiKey: async () => 'sk-relay', models: ['image-2'], provider: 'openai-compat' }])

  it('addresses models as provider:endpoint/model and posts to the relay', async () => {
    const [m] = await adapter.listModels()
    expect(m!.id).toBe('openai-compat:relay/image-2')
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ data: [{ b64_json: PNG_B64 }] }), { headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)
    const result = await adapter.submit(req({ params: { size: '1024x1024', quality: 'high' } }), m!, ctx())
    expect(result.kind).toBe('done')
    const call = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(call[0]).toBe('https://relay.example/v1/images/generations')
    expect(JSON.parse(String(call[1].body))).toMatchObject({ model: 'image-2', prompt: 'a boat', size: '1024x1024', quality: 'high' })
  })

  it('uses the edit endpoint when input images are given', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ data: [{ b64_json: PNG_B64 }] }), { headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)
    const [m] = await adapter.listModels()
    await adapter.submit(req({ op: 'edit', inputs: { source: { assetId: 'a' } } }), m!, ctx())
    expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toContain('/images/edits')
  })

  it('not configured without a key or base URL', async () => {
    expect(await new CompatAdapter('openai', () => [{ id: 'd', label: 'OpenAI', baseURL: '', apiKey: async () => 'k', models: ['m'], provider: 'openai' }]).isConfigured()).toBe(false)
  })
})

describe('Subscription adapter (legacy port)', () => {
  it('is configured only when the manager exists and the account is signed in; models are free-of-charge', async () => {
    const manager = { generate: vi.fn(async () => [{ b64_json: PNG_B64 }]) }
    const adapter = new SubscriptionAdapter('grok-sub', () => manager as never, async () => true)
    expect(await adapter.isConfigured()).toBe(true)
    expect(await new SubscriptionAdapter('grok-sub', () => manager as never, async () => false).isConfigured()).toBe(false)
    expect(await new SubscriptionAdapter('grok-sub', () => undefined, async () => true).isConfigured()).toBe(false)
    const [m] = await adapter.listModels()
    expect(m).toMatchObject({ id: 'grok-sub:grok-imagine-image-2.0', pricing: { unit: 'run', usd: 0 } })
    const result = await adapter.submit(req({ params: { aspect_ratio: '16:9', resolution: '1k' } }), m!, ctx())
    expect(result.kind).toBe('done')
    expect(manager.generate).toHaveBeenCalledWith(expect.objectContaining({ vendor: 'grok', prompt: 'a boat', size: '16:9' }))
  })

  it('classifies "not logged in" as auth so the job needs attention', async () => {
    const manager = { generate: vi.fn(async () => { throw new Error('Grok subscription is not logged in') }) }
    const adapter = new SubscriptionAdapter('grok-sub', () => manager as never, async () => true)
    await expect(adapter.submit(req(), (await adapter.listModels())[0]!, ctx())).rejects.toMatchObject({ kind: 'auth' })
  })
})

describe('ComfyUI frame size (legacy port)', () => {
  const sized = { name: 'sized', presetPrompt: 'masterpiece', json: JSON.stringify({ '5': { class_type: 'EmptyLatentImage', inputs: { width: '{{width}}', height: '{{height}}' } }, '6': { class_type: 'CLIPTextEncode', inputs: { text: '{{prompt}}' } } }) }
  const run = async (params: Record<string, string | number>): Promise<Record<string, any>> => {
    const calls: { url: string; body?: string }[] = []
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), ...(init?.body === undefined ? {} : { body: String(init.body) }) })
      if (String(url).endsWith('/prompt')) return new Response(JSON.stringify({ prompt_id: 'j1' }))
      if (String(url).includes('/history')) return new Response(JSON.stringify({ j1: { status: { status_str: 'success', completed: true }, outputs: { save: { images: [{ filename: 'f.png', subfolder: '', type: 'output' }] } } } }))
      return new Response(PNG, { headers: { 'content-type': 'image/png' } })
    })
    vi.stubGlobal('fetch', fetchMock)
    const adapter = new ComfyUIAdapter({ baseURL: () => 'http://127.0.0.1:8188', timeoutMs: () => 5000, workflows: () => [sized] })
    const [m] = await adapter.listModels()
    await adapter.submit(req({ prompt: 'a portrait', params }), m!, ctx())
    return JSON.parse(calls.find(c => c.url.endsWith('/prompt'))!.body!).prompt
  }

  it('maps an aspect ratio onto the workflow width/height placeholders and prepends the preset prompt', async () => {
    const wf = await run({ aspect_ratio: '9:16' })
    expect(wf[5].inputs).toEqual({ width: 768, height: 1344 }); expect(wf[6].inputs.text).toBe('masterpiece a portrait')
  })
  it('an exact size beats the ratio, and a workflow without size placeholders ignores both', async () => {
    expect((await run({ aspect_ratio: '1:1', width: 640, height: 480 }))[5].inputs).toEqual({ width: 640, height: 480 })
    const adapter = new ComfyUIAdapter({ baseURL: () => 'x', timeoutMs: () => 1, workflows: () => [{ name: 'fixed', json: JSON.stringify({ '1': { class_type: 'CLIPTextEncode', inputs: { text: '{{prompt}}' } } }) }] })
    expect((await adapter.listModels())[0]!.params).toEqual([])
  })
})

describe('ComfyUI adapter (legacy port)', () => {
  const t2i = { name: 'sdxl', json: JSON.stringify({ '1': { class_type: 'CLIPTextEncode', inputs: { text: '{{prompt}}' } }, '2': { class_type: 'KSampler', inputs: { seed: '{{seed}}' } } }) }
  const i2i = { name: 'edit', json: JSON.stringify({ '1': { class_type: 'CLIPTextEncode', inputs: { text: '{{prompt}}' } }, '3': { class_type: 'LoadImage', inputs: { image: '{{image}}' } } }) }
  const adapter = new ComfyUIAdapter({ baseURL: () => 'http://127.0.0.1:8188', timeoutMs: () => 5000, workflows: () => [t2i, i2i] })

  it('turns each imported workflow into a model whose capabilities follow its {{image}} slots', async () => {
    const models = await adapter.listModels()
    expect(models.map(m => [m.id, m.capabilities])).toEqual([['comfyui:sdxl', ['t2i']], ['comfyui:edit', ['t2i', 'i2i']]])
    expect(models[1]!.inputs.images?.max).toBe(1)
    expect(models.every(m => m.pricing?.usd === 0)).toBe(true)
    expect(await new ComfyUIAdapter({ baseURL: () => 'x', timeoutMs: () => 1, workflows: () => [] }).isConfigured()).toBe(false)
  })

  it('rejects a workflow that was removed after the model list was built', async () => {
    const stale = new ComfyUIAdapter({ baseURL: () => 'http://127.0.0.1:8188', timeoutMs: () => 5000, workflows: () => [] })
    await expect(stale.submit(req(), { ...(await adapter.listModels())[0]! }, ctx())).rejects.toMatchObject({ kind: 'invalid' })
  })
})
