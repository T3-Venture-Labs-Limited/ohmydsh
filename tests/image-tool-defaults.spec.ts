import type { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apply } from '../src/index.js'
import { SubscriptionManager } from '../src/subscription.js'
import { imageToolContext } from '../src/image-tool-context.js'

function harness() {
  const tools: any[] = []
  const contexts: Array<{ name: string; text: () => string }> = []
  const promptDisposers: Array<() => void> = []
  const credentialListeners = new Map<string, () => void>()
  const config = { provider: 'openai-compat', openaiCompatBaseURL: 'https://relay.example/v1', openaiCompatModel: 'relay-generate', openaiCompatEditModel: 'relay-edit', saveToWorkspace: false }
  const ref = { attachmentId: 'sha256:source', mediaType: 'image/png', bytes: 8, width: 1, height: 1 }
  const resolveCredential = vi.fn(async () => ({ value: 'offline-test-key' } as { value: string } | undefined))
  const ctx = {
    tools: { register: (tool: unknown) => tools.push(tool) }, effect: (setup: () => unknown) => setup(),
    webServer: { register: () => () => {} }, credentials: { resolve: resolveCredential },
    inject: (services: string[], callback: (owner: unknown) => void) => {
      if (services.includes('credentials')) callback({ on: (event: string, listener: () => void) => { credentialListeners.set(event, listener) } })
      if (services.includes('settings')) callback({ settings: { installSection: vi.fn() } })
      if (services.includes('systemPrompt')) callback({
        effect: (setup: () => unknown) => {
          const dispose = setup()
          if (typeof dispose === 'function') promptDisposers.push(dispose as () => void)
        },
        systemPrompt: {
          context: (item: { name: string; text: () => string }) => {
            contexts.push(item)
            return () => { contexts.splice(contexts.indexOf(item), 1) }
          },
        },
      })
    },
    attachments: { imageLimits: { maxImageBytes: 1024, mediaTypes: ['image/png'] }, readImage: vi.fn(async () => ({ ref, data: new Uint8Array([137,80,78,71]) })), saveImage: vi.fn(async () => ref) },
    logger: { warn: vi.fn() },
  } as unknown as Context
  apply(ctx, config as never)
  const exec = { signal: new AbortController().signal, agent: { session: { header: {}, deriveMessages: () => [{ source: { kind: 'user' }, content: [{ type: 'image', attachment: ref }] }] } } }
  return { config, contexts, promptDisposers, credentialListeners, resolveCredential, tool: (name: string) => tools.find(tool => tool.name === name), exec }
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('image tool defaults and placeholders', () => {
  it('names the Studio tools and the default provider, and tells the model to omit provider and model', () => {
    const text = imageToolContext({ provider: 'openai-compat' } as never, ['grok-sub', 'replicate'])
    expect(text).toContain('studio_make')
    expect(text).toContain('Default provider: openai-compat.')
    expect(text).toContain('Configured providers (key saved, subscription signed in, or ComfyUI workflow present): grok-sub, replicate.')
    expect(text).toContain('OMIT provider and model from studio_make')
    for (const gone of ['studio_generate', 'studio_edit', 'studio_generate_batch']) expect(text).not.toContain(gone)
    expect(imageToolContext({ provider: 'google' } as never, [])).toContain('Configured providers (key saved, subscription signed in, or ComfyUI workflow present): none.')
    expect(imageToolContext({ provider: 'google' } as never)).not.toContain('Configured providers')
  })
  it('lists the ComfyUI workflow names the workflow argument accepts', () => {
    expect(imageToolContext({ provider: 'openai' } as never)).not.toContain('ComfyUI workflows')
    const workflows = [{ name: '人像 "8步"', json: '{}' }, { name: 'landscape', json: '{}' }]
    const text = imageToolContext({ provider: 'comfyui', comfyuiWorkflows: workflows, comfyuiActiveWorkflow: 'landscape' } as never)
    expect(text).toContain('ComfyUI workflows available for the workflow argument (provider=comfyui): "人像 \\"8步\\"", "landscape"; active: "landscape"')
    const many = Array.from({ length: 23 }, (_, index) => ({ name: `wf-${String(index)}`, json: '{}' }))
    const capped = imageToolContext({ provider: 'comfyui', comfyuiWorkflows: many } as never)
    expect(capped).toContain('"wf-19" (+3 more); active: "wf-0"')
    expect(capped).not.toContain('"wf-20"')
  })
  it('registers one model-facing generation entry point whose provider and model arguments are optional hints', () => {
    const h = harness()
    const make = h.tool('studio_make')
    expect(make.parameters.properties.model.description).toContain('OMIT to let Studio pick')
    expect(make.parameters.properties.provider.description).toContain('OMIT unless the user names a provider')
    for (const removed of ['studio_generate', 'studio_generate_batch', 'studio_edit']) expect(h.tool(removed)).toBeUndefined()
  })
  it('disposes the image prompt context with its Cordis scope', () => {
    const h = harness()
    expect(h.contexts).toHaveLength(1)
    expect(h.promptDisposers).toHaveLength(1)
    for (const dispose of h.promptDisposers) dispose()
    expect(h.contexts).toHaveLength(0)
  })
})
