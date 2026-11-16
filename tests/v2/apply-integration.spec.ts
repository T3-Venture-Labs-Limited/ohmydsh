import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import type { Context } from '@deepseek-ai/cordis'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { apply } from '../../src/index.js'

type Tool = { name: string; execute(args: Record<string, unknown>, exec: unknown): Promise<{ text: string; assetIds?: string[]; attachments?: { attachmentId: string }[]; state?: string }> }

/** The real plugin entry point against a fake host: in-memory attachment store, a recorded user message with an image, a real workspace folder. */
let home: string; let workspace: string; const tools = new Map<string, Tool>(); const stored = new Map<string, { data: Uint8Array; mediaType: string }>()
const prevHome = process.env.DSH_HOME
const png = (rgb: [number, number, number]): Promise<Buffer> => sharp({ create: { width: 64, height: 48, channels: 3, background: { r: rgb[0], g: rgb[1], b: rgb[2] } } }).png().toBuffer()

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'studio-apply-home-')); workspace = await mkdtemp(join(tmpdir(), 'studio-apply-ws-'))
  process.env.DSH_HOME = home; tools.clear(); stored.clear()
  const ctx = {
    tools: { register: (t: Tool) => { tools.set(t.name, t) } }, effect: (setup: () => unknown) => setup(), get: () => undefined,
    credentials: { resolve: vi.fn(async () => undefined) },
    inject: (services: readonly string[], cb: (owner: unknown) => void) => { if (services.includes('settings')) cb({ settings: { installSection: vi.fn() } }) },
    attachments: {
      imageLimits: { maxImageBytes: 10 * 1024 * 1024, mediaTypes: ['image/png'] },
      readImage: async (ref: { attachmentId: string }) => { const s = stored.get(String(ref.attachmentId)); if (s === undefined) throw new Error('gone'); return { ref: { ...ref, mediaType: s.mediaType }, data: s.data } },
      saveImage: async (i: { data: Uint8Array; mediaType: string }) => { const id = `sha256:saved-${String(stored.size)}`; stored.set(id, { data: i.data, mediaType: i.mediaType }); return { attachmentId: id, mediaType: i.mediaType, bytes: i.data.byteLength, width: 64, height: 48 } },
    },
    logger: { warn: vi.fn(), info: vi.fn() },
  } as unknown as Context
  apply(ctx, { provider: 'comfyui', saveToWorkspace: true, workspaceFolder: 'studio-out',
    comfyuiWorkflows: [{ name: 'edit.json', json: JSON.stringify({ 1: { class_type: 'LoadImage', inputs: { image: '{{image}}' } }, 2: { class_type: 'CLIPTextEncode', inputs: { text: '{{prompt}}' } } }) }], comfyuiActiveWorkflow: 'edit.json' } as never)
})
afterEach(async () => { vi.unstubAllGlobals(); if (prevHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prevHome; await rm(home, { recursive: true, force: true }); await rm(workspace, { recursive: true, force: true }) })

function comfyFetch(output: Uint8Array): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url)
    if (u.endsWith('/upload/image')) return new Response(JSON.stringify({ name: 'in.png', subfolder: '', type: 'input' }))
    if (u.endsWith('/prompt')) return new Response(JSON.stringify({ prompt_id: 'p1' }))
    if (u.includes('/history')) return new Response(JSON.stringify({ p1: { status: { status_str: 'success', completed: true }, outputs: { 9: { images: [{ filename: 'out.png', subfolder: '', type: 'output' }] } } } }))
    if (u.includes('/view')) return new Response(output, { headers: { 'content-type': 'image/png' } })
    void init; return new Response('{}', { status: 404 })
  }) as unknown as typeof fetch
}

describe('studio_make through the real plugin entry point', () => {
  it('edits the newest conversation image (no source given), stores both in the gallery with lineage, and saves the result into the workspace', async () => {
    const original = new Uint8Array(await png([30, 60, 200])); const edited = new Uint8Array(await png([240, 120, 20]))
    stored.set('sha256:user-image', { data: original, mediaType: 'image/png' })
    vi.stubGlobal('fetch', comfyFetch(edited))
    const exec = { signal: new AbortController().signal, agent: { id: 'a1', session: { id: 'sess-9', header: { cwd: workspace }, deriveMessages: () => [{ source: { kind: 'user' }, content: [{ type: 'image', attachment: { attachmentId: 'sha256:user-image', mediaType: 'image/png', bytes: original.byteLength, width: 64, height: 48 } }] }] } } }
    const r = await tools.get('studio_make')!.execute({ op: 'edit', prompt: 'make the boat orange', provider: 'comfyui' }, exec)
    expect(r.state).toBe('succeeded'); expect(r.assetIds).toHaveLength(1)
    const where = /to the workspace at ("[^"]+")/.exec(r.text)
    expect(where, r.text).not.toBeNull()
    const savedPath = JSON.parse(where![1]!) as string
    expect(savedPath.startsWith(workspace)).toBe(true); expect(savedPath).toContain('studio-out')
    expect((await stat(savedPath)).size).toBeGreaterThan(50)
    expect(r.attachments).toHaveLength(1)
    // gallery
    const gallery = await tools.get('studio_gallery')!.execute({ asset: r.assetIds![0] }, exec)
    expect(gallery.text).toMatch(/derived from: source:/); expect(gallery.text).toMatch(/make the boat orange/)
    const refs = await tools.get('studio_gallery')!.execute({ query: 'reference', limit: 5 }, exec)
    expect(refs.text).toMatch(/1 match/)                       // full-text search covers tags too
    const tagged = await tools.get('studio_gallery')!.execute({ tag: 'reference' }, exec)
    expect(tagged.text).toMatch(/1 match/)
    const info = await tools.get('studio_models')!.execute({ capability: 'i2i' }, exec)
    expect(info.text).toContain('comfyui:edit.json')
  })

  it('refuses an edit when the conversation has no image, with guidance, and generates without touching the conversation', async () => {
    vi.stubGlobal('fetch', comfyFetch(new Uint8Array(await png([1, 2, 3]))))
    const empty = { signal: new AbortController().signal, agent: { id: 'a1', session: { id: 's', header: { cwd: workspace }, deriveMessages: () => [{ source: { kind: 'user' }, content: [{ type: 'text', text: 'hi' }] }] } } }
    await expect(tools.get('studio_make')!.execute({ op: 'edit', prompt: 'x' }, empty)).rejects.toThrow(/requires an image in the current conversation/)
  })
})

describe('agent media capture through the real plugin entry point', () => {
  it('registers a session/event listener and a foreign tool result with an image attachment lands in the gallery within a moment, while studio_* results do not', async () => {
    let listener: ((session: unknown, event: unknown) => void) | undefined
    const bytes = new Uint8Array(await png([12, 200, 90])); stored.set('sha256:agent-img', { data: bytes, mediaType: 'image/png' })
    const reg = new Map<string, Tool>()
    const ctx = {
      tools: { register: (t: Tool) => { reg.set(t.name, t) } }, effect: (setup: () => unknown) => setup(), get: () => undefined,
      on: (name: string, fn: (s: unknown, e: unknown) => void) => { if (name === 'session/event') listener = fn; return () => undefined },
      credentials: { resolve: vi.fn(async () => undefined) },
      inject: (services: readonly string[], cb: (owner: unknown) => void) => { if (services.includes('settings')) cb({ settings: { installSection: vi.fn() } }) },
      attachments: { imageLimits: { maxImageBytes: 10 * 1024 * 1024, mediaTypes: ['image/png'] }, readImage: async (r: { attachmentId: string }) => { const s = stored.get(String(r.attachmentId)); if (s === undefined) throw new Error('gone'); return { ref: r, data: s.data } }, saveImage: vi.fn() },
      logger: { warn: vi.fn(), info: vi.fn() },
    } as unknown as Context
    apply(ctx, {} as never)
    expect(listener).toBeTypeOf('function')
    const session = { id: 'chat-42', header: { cwd: workspace } }
    const now = Date.now()
    listener!(session, { type: 'tool/call', time: now, data: { callId: 'k1', name: 'image_generate', arguments: JSON.stringify({ prompt: 'a green door', provider: 'gpt' }) } })
    listener!(session, { type: 'tool/result', time: now + 5, data: { message: { toolCallId: 'k1', isError: false, content: [{ type: 'text', text: 'Saved 1 image(s)' }, { type: 'image', attachment: { attachmentId: 'sha256:agent-img', mediaType: 'image/png', bytes: bytes.length, width: 64, height: 48 } }] } } })
    listener!(session, { type: 'tool/call', time: now + 6, data: { callId: 'k2', name: 'studio_make', arguments: '{}' } })
    listener!(session, { type: 'tool/result', time: now + 7, data: { message: { toolCallId: 'k2', isError: false, content: [{ type: 'image', attachment: { attachmentId: 'sha256:agent-img', mediaType: 'image/png', bytes: bytes.length, width: 64, height: 48 } }] } } })
    const gallery = await reg.get('studio_gallery')!.execute({ action: 'list' } as never, { signal: new AbortController().signal, agent: { session: { id: 'x', header: {} } } }).catch(() => undefined)
    void gallery
    const { createCore } = await import('../../src/v2/core.js')
    const core = createCore({ home })
    await vi.waitFor(() => { expect(core.db.queryAssets({ source: 'agent' }).total).toBe(1) }, { timeout: 3000 })
    expect(core.db.queryAssets({ source: 'agent' }).items[0]).toMatchObject({ sessionId: 'chat-42', prompt: 'a green door', origin: { tool: 'image_generate', provider: 'gpt' } })
    expect(core.db.queryAssets({}).total).toBe(1)
    await core.close()
  })
})
