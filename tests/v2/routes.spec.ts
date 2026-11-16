import { createServer, type Server } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { jobsStream, type JobsFrame } from '../../src/v2/push.js'
import type { ModelDescriptor, OperationRequest, ProviderAdapter, SubmitResult } from '../../src/v2/contracts.js'
import { createCore, type StudioCore } from '../../src/v2/core.js'
import { createV2Handler, ROUTE_BASE } from '../../src/v2/routes/index.js'
import { parseRange } from '../../src/v2/routes/assets.js'
import { parseOperationRequest } from '../../src/v2/request.js'

const PNG = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'))
const model: ModelDescriptor = { id: 'openrouter:t/img', provider: 'openrouter', remoteId: 'img', label: 'T', capabilities: ['t2i'], inputs: {}, params: [], async: 'sync', curated: true }
const adapter: ProviderAdapter = {
  id: 'openrouter', isConfigured: async () => true, listModels: async () => [model],
  submit: async (_r: OperationRequest): Promise<SubmitResult> => ({ kind: 'done', outputs: [{ bytes: PNG, mediaType: 'image/png' }], cost: { usd: 0.02, source: 'provider' } }),
}

let dir: string; let core: StudioCore; let server: Server; let base: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'studio-routes-'))
  core = createCore({ root: dir, runner: { sleep: async () => { await Promise.resolve() } } })
  core.registry.register(adapter)
  const handler = createV2Handler(core, undefined, { readAttachment: async ref => { if (String(ref.attachmentId) !== 'att-1') throw new Error('gone'); return PNG }, vaultDirs: [join(dir, 'old-vault')] })
  server = createServer((req, res) => { void handler(req, res) })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}${ROUTE_BASE}`
})
afterEach(async () => { server.closeAllConnections(); await new Promise(r => server.close(r)); await core.close(); await rm(dir, { recursive: true, force: true }) })

const post = (path: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })

describe('v2 routes', () => {
  it('runs a job through the API and serves the asset with Range support', async () => {
    const created = await post('/jobs', { op: 'generate', modelId: model.id, prompt: 'a boat', inputs: {}, params: {} })
    expect(created.status).toBe(202)
    const { job } = await created.json() as { job: { id: string } }
    const done = await core.runner.wait(job.id, 5000)
    expect(done.state).toBe('succeeded')
    const list = await (await fetch(`${base}/assets`)).json() as { items: { id: string; prompt: string }[]; total: number }
    expect(list.total).toBe(1); expect(list.items[0]!.prompt).toBe('a boat')
    const id = list.items[0]!.id
    const whole = await fetch(`${base}/assets/${id}/file`)
    expect(whole.status).toBe(200)
    expect(whole.headers.get('content-type')).toBe('image/png'); expect(whole.headers.get('accept-ranges')).toBe('bytes'); expect(whole.headers.get('x-content-type-options')).toBe('nosniff')
    expect(new Uint8Array(await whole.arrayBuffer())).toEqual(PNG)
    const part = await fetch(`${base}/assets/${id}/file`, { headers: { range: 'bytes=0-7' } })
    expect(part.status).toBe(206); expect(part.headers.get('content-range')).toBe(`bytes 0-7/${String(PNG.byteLength)}`)
    expect((await part.arrayBuffer()).byteLength).toBe(8)
    expect((await fetch(`${base}/assets/${id}/file`, { headers: { range: 'bytes=999-1000' } })).status).toBe(416)
    expect((await fetch(`${base}/assets/${id}/file`, { method: 'HEAD' })).headers.get('content-length')).toBe(String(PNG.byteLength))
  })

  it('rejects cross-origin and cross-site mutations but allows same-origin ones and reads', async () => {
    const body = { op: 'generate', modelId: model.id, prompt: 'x', inputs: {}, params: {} }
    expect((await post('/jobs', body, { origin: 'https://evil.example' })).status).toBe(403)
    expect((await post('/jobs', body, { 'sec-fetch-site': 'cross-site' })).status).toBe(403)
    expect((await post('/jobs', body, { origin: new URL(base).origin })).status).toBe(202)
    expect((await fetch(`${base}/jobs`, { headers: { origin: 'https://evil.example' } })).status).toBe(200)
    const patched = await fetch(`${base}/assets/ABCDEFGH12345678`, { method: 'PATCH', headers: { 'content-type': 'application/json', origin: 'https://evil.example' }, body: '{}' })
    expect(patched.status).toBe(403)
    expect((await fetch(`${base}/assets/ABCDEFGH12345678`, { method: 'DELETE', headers: { origin: 'https://evil.example' } })).status).toBe(403)
  })

  it('validates request bodies strictly and maps adapter errors onto HTTP statuses', async () => {
    expect((await post('/jobs', { op: 'explode', modelId: model.id })).status).toBe(400)
    expect((await post('/jobs', { op: 'generate', modelId: 'nonsense' })).status).toBe(400)
    expect((await post('/jobs', { op: 'generate', modelId: model.id, inputs: { source: '../../etc/passwd' } })).status).toBe(400)
    expect((await post('/jobs', { op: 'generate', modelId: model.id, params: { 'a b': 1 } })).status).toBe(400)
    expect((await post('/jobs', { op: 'generate', modelId: 'openrouter:t/missing', prompt: 'x' })).status).toBe(400)
    const bad = await fetch(`${base}/jobs`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'x' })
    expect(bad.status).toBe(415)
    const big = await fetch(`${base}/jobs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: 'x'.repeat(9 * 1024 * 1024) }) })
    expect(big.status).toBe(413)
  })

  it('assets: patch, tags, lineage, search, soft delete, 404 for unknown/unsafe ids', async () => {
    const a = await core.assets.ingestBytes(PNG, 'image/png', { source: 'generated', prompt: 'lighthouse at dawn' })
    const patched = await fetch(`${base}/assets/${a.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ favorite: true, title: 'Beacon', rating: 9 }) })
    expect((await patched.json() as { asset: { favorite: boolean; title: string; rating: number } }).asset).toMatchObject({ favorite: true, title: 'Beacon', rating: 5 })
    const tagged = await post(`/assets/${a.id}/tags`, { add: ['Sea', 'dawn'], remove: ['nothing'] })
    expect((await tagged.json() as { tags: string[] }).tags).toEqual(['dawn', 'sea'])
    expect((await (await fetch(`${base}/assets?q=lighthouse&tag=sea&favorite=1`)).json() as { total: number }).total).toBe(1)
    expect((await fetch(`${base}/assets/${a.id}/lineage`)).status).toBe(200)
    expect((await fetch(`${base}/assets/..%2F..%2Fx/file`)).status).toBe(404)
    expect((await fetch(`${base}/assets/ZZZZZZZZZZZZZZZZ/file`)).status).toBe(404)
    await fetch(`${base}/assets/${a.id}`, { method: 'DELETE' })
    expect((await fetch(`${base}/assets/${a.id}/file`)).status).toBe(404)
    expect((await (await fetch(`${base}/assets`)).json() as { total: number }).total).toBe(0)
  })

  it('collections, spend and stats endpoints', async () => {
    const a = await core.assets.ingestBytes(PNG, 'image/png', { source: 'generated', provider: 'openrouter', costUsd: 0.07 })
    const created = await (await post('/collections', { name: 'Favs' })).json() as { id: string }
    await post(`/assets/${a.id}/collections`, { add: created.id })
    expect((await (await fetch(`${base}/collections`)).json() as { collections: { count: number }[] }).collections[0]!.count).toBe(1)
    expect((await (await fetch(`${base}/spend`)).json() as { spend: { usd: number }[] }).spend[0]!.usd).toBe(0.07)
    expect((await (await fetch(`${base}/stats`)).json() as { count: number }).count).toBe(1)
    expect((await post('/collections', { name: '  ' })).status).toBe(400)
  })

  it('the live stream pushes a snapshot then every job state change without polling', async () => {
    const abort = new AbortController(); const frames: JobsFrame[] = []
    const reader = (async () => { for await (const f of jobsStream(core, abort.signal)) frames.push(f) })()
    await vi.waitFor(() => { expect(frames[0]?.event).toBe('snapshot') })
    await post('/jobs', { op: 'generate', modelId: model.id, prompt: 'x', inputs: {}, params: {} })
    await vi.waitFor(() => { expect(frames.some(f => f.event === 'job' && (f.data as { state: string }).state === 'succeeded')).toBe(true) })
    const states = frames.filter(f => f.event === 'job').map(f => (f.data as { state: string }).state)
    expect(states).toEqual(expect.arrayContaining(['queued', 'submitting', 'finalizing', 'succeeded']))
    abort.abort(); await reader
  })

  it('has no HTTP event stream any more (a stream would hold one of the browser\'s 6 connections)', async () => {
    expect((await fetch(`${base}/jobs/stream`)).status).toBe(404)
  })

  it('cancel and retry endpoints; models and providers never expose secrets', async () => {
    const original = adapter.submit
    adapter.submit = async () => { throw Object.assign(new Error('x'), { name: 'AdapterError', kind: 'auth' }) }
    const created = await post('/jobs', { op: 'generate', modelId: model.id, prompt: 'x', inputs: {}, params: {} })
    const { job } = await created.json() as { job: { id: string } }
    await core.runner.wait(job.id, 5000)
    const final = await (await fetch(`${base}/jobs/${job.id}`)).json() as { job: { state: string }; request: { prompt: string } }
    expect(['failed', 'needs_attention']).toContain(final.job.state); expect(final.request.prompt).toBe('x')
    expect((await post(`/jobs/${job.id}/cancel`, {})).status).toBe(200)
    expect((await fetch(`${base}/jobs/nope`)).status).toBe(404)
    const models = await (await fetch(`${base}/models?capability=t2i`)).json() as { models: { id: string }[] }
    expect(models.models.map(m => m.id)).toEqual([model.id])
    expect(JSON.stringify(await (await fetch(`${base}/providers`)).json())).toContain('"id":"openrouter","configured":true')
    adapter.submit = original
  })
})

describe('request parsing and ranges', () => {
  it('parseRange handles open, suffix and invalid ranges', () => {
    expect(parseRange(undefined, 100)).toBeUndefined()
    expect(parseRange('bytes=0-9', 100)).toEqual({ start: 0, end: 9 })
    expect(parseRange('bytes=90-', 100)).toEqual({ start: 90, end: 99 })
    expect(parseRange('bytes=-10', 100)).toEqual({ start: 90, end: 99 })
    expect(parseRange('bytes=50-500', 100)).toEqual({ start: 50, end: 99 })
    for (const bad of ['bytes=100-', 'bytes=9-3', 'bytes=-', 'bytes=0-1,5-6', 'items=0-1', 'bytes=-0']) expect(parseRange(bad, 100)).toBeNull()
  })

  it('parseOperationRequest records origin/session and clamps list sizes', () => {
    const r = parseOperationRequest({ op: 'upscale', modelId: 'replicate:a/b', inputs: { source: { assetId: 'ABCDEFGH1234' } }, params: { n: 2 }, tags: ['x', '', 5] }, 'agent', 'sess-1')
    expect(r).toMatchObject({ op: 'upscale', origin: 'agent', sessionId: 'sess-1', tags: ['x'], inputs: { source: { assetId: 'ABCDEFGH1234' } } })
    expect(() => parseOperationRequest({ op: 'generate', modelId: 'a:b', inputs: { references: Array.from({ length: 17 }, () => 'ABCDEFGH1234') } }, 'ui')).toThrow(/at most 16/)
  })
})

describe('import and estimate routes', () => {
  it('imports raw media with title/tags, rejects non-media and oversize declarations, and is same-origin only', async () => {
    const ok = await fetch(`${base}/assets/import?title=Mask&tags=mask,Ref`, { method: 'POST', headers: { 'content-type': 'image/png' }, body: PNG })
    expect(ok.status).toBe(201)
    const { asset } = await ok.json() as { asset: { id: string; source: string; title: string; tags: string[]; width: number } }
    expect(asset).toMatchObject({ source: 'import', title: 'Mask', tags: ['mask', 'ref'], width: 1 })
    expect((await fetch(`${base}/assets/import`, { method: 'POST', headers: { 'content-type': 'text/html' }, body: '<script>' })).status).toBe(415)
    expect((await fetch(`${base}/assets/import`, { method: 'POST', headers: { 'content-type': 'image/png' }, body: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]) })).status).toBe(400)
    expect((await fetch(`${base}/assets/import`, { method: 'POST', headers: { 'content-type': 'image/png', origin: 'https://evil.example' }, body: PNG })).status).toBe(403)
  })

  it('estimate prices and validates a request without creating a job', async () => {
    const good = await post('/estimate', { op: 'generate', modelId: model.id, prompt: 'x', inputs: {}, params: {} })
    expect(await good.json()).toMatchObject({ ok: true, configured: true, issues: [], model: { id: model.id, async: 'sync' } })
    const bad = await (await post('/estimate', { op: 'inpaint', modelId: model.id, prompt: 'x' })).json() as { ok: boolean; issues: { path: string }[] }
    expect(bad.ok).toBe(false); expect(bad.issues[0]!.path).toBe('op')
    const unknown = await (await post('/estimate', { op: 'generate', modelId: 'openrouter:nope/x' })).json() as { ok: boolean }
    expect(unknown.ok).toBe(false)
    expect((await (await fetch(`${base}/jobs`)).json() as { jobs: unknown[] }).jobs).toEqual([])
  })
})

describe('asset push events', () => {
  it('streams an asset event for generated and imported assets (and not after the client disconnects)', async () => {
    const abort = new AbortController(); const frames: JobsFrame[] = []
    const reader = (async () => { for await (const f of jobsStream(core, abort.signal)) frames.push(f) })()
    await vi.waitFor(() => { expect(frames[0]?.event).toBe('snapshot') })
    await fetch(`${base}/assets/import?title=Pasted`, { method: 'POST', headers: { 'content-type': 'image/png' }, body: PNG })
    await vi.waitFor(() => { expect(frames.some(f => f.event === 'asset')).toBe(true) })
    expect(frames.find(f => f.event === 'asset')!.data).toMatchObject({ kind: 'image', source: 'import', title: 'Pasted', favorite: false, tags: [] })
    await post('/jobs', { op: 'generate', modelId: model.id, prompt: 'x', inputs: {}, params: {} })
    await vi.waitFor(() => { expect(frames.filter(f => f.event === 'asset')).toHaveLength(2) })
    abort.abort(); await reader
    const count = frames.length
    // No listener left behind: a later ingest must not throw, leak or reach the cancelled stream.
    await core.assets.ingestBytes(PNG, 'image/png', { source: 'import' })
    expect(frames).toHaveLength(count)
  })
})

describe('collection filter and membership', () => {
  it('filters assets by collection and reports membership on the detail route', async () => {
    const a = await core.assets.ingestBytes(PNG, 'image/png', { source: 'generated', prompt: 'one' })
    const b = await core.assets.ingestBytes(new Uint8Array([...PNG, 1]), 'image/png', { source: 'generated', prompt: 'two' })
    const { id: c1 } = await (await post('/collections', { name: 'A' })).json() as { id: string }
    const { id: c2 } = await (await post('/collections', { name: 'B' })).json() as { id: string }
    await post(`/assets/${a.id}/collections`, { add: c1 }); await post(`/assets/${a.id}/collections`, { add: c2 }); await post(`/assets/${b.id}/collections`, { add: c2 })
    expect((await (await fetch(`${base}/assets?collection=${c1}`)).json() as { items: { id: string }[] }).items.map(x => x.id)).toEqual([a.id])
    expect((await (await fetch(`${base}/assets?collection=${c2}`)).json() as { total: number }).total).toBe(2)
    expect((await (await fetch(`${base}/assets?collection=nope`)).json() as { total: number }).total).toBe(0)
    expect((await (await fetch(`${base}/assets/${a.id}`)).json() as { collections: string[] }).collections).toEqual([c1, c2].sort())
    await post(`/assets/${a.id}/collections`, { remove: c1 })
    expect((await (await fetch(`${base}/assets/${a.id}`)).json() as { collections: string[] }).collections).toEqual([c2])
  })
})

describe('zip export', () => {
  it('streams a valid stored ZIP with sanitized names, from GET and POST, and rejects bad selections', async () => {
    const a = await core.assets.ingestBytes(PNG, 'image/png', { source: 'generated', prompt: 'A red paper boat / at <dawn>!' })
    const b = await core.assets.ingestBytes(new Uint8Array([...PNG, 0]), 'image/png', { source: 'generated', title: '../../etc/passwd' })
    const res = await fetch(`${base}/assets/zip?ids=${a.id},${b.id}`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/zip'); expect(res.headers.get('content-disposition')).toContain('attachment')
    const buf = Buffer.from(await res.arrayBuffer())
    expect(buf.readUInt32LE(0)).toBe(0x04034b50)
    // Walk the central directory (end record -> offset -> 46-byte headers) instead of guessing with a regex.
    const end = buf.length - 22; const count = buf.readUInt16LE(end + 10); let at = buf.readUInt32LE(end + 16); const names: string[] = []
    for (let i = 0; i < count; i++) { const n = buf.readUInt16LE(at + 28); names.push(buf.toString('utf8', at + 46, at + 46 + n)); at += 46 + n + buf.readUInt16LE(at + 30) + buf.readUInt16LE(at + 32) }
    expect(names).toEqual([`${a.id}-a-red-paper-boat-at-dawn.png`, `${b.id}-etc-passwd.png`])
    expect(buf.readUInt16LE(buf.length - 22 + 10)).toBe(2)
    const posted = await post('/assets/zip', { ids: [a.id, a.id] })
    expect(posted.status).toBe(200); expect((await posted.arrayBuffer()).byteLength).toBeGreaterThan(PNG.byteLength)
    expect((await fetch(`${base}/assets/zip`)).status).toBe(400)
    expect((await fetch(`${base}/assets/zip?ids=ZZZZZZZZZZZZZZZZ`)).status).toBe(404)
    expect((await post('/assets/zip', { ids: Array.from({ length: 501 }, (_, i) => `ABCDEFGH${String(i).padStart(4, '0')}`) }, { origin: 'https://evil.example' })).status).toBe(403)
    await core.assets.softDelete(a.id)
    expect((await fetch(`${base}/assets/zip?ids=${a.id}`)).status).toBe(404)
  })
})

describe('model examples route', () => {
  it('is unavailable without a token, for non-Replicate models, and never calls out', async () => {
    expect(await (await fetch(`${base}/models/examples?modelId=openrouter:x/y`)).json()).toEqual({ available: false, examples: [] })
    expect(await (await fetch(`${base}/models/examples?modelId=replicate:a/b`)).json()).toEqual({ available: false, examples: [] })
    expect((await fetch(`${base}/models/examples`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status).toBe(405)
  })
})

describe('settings and provider info', () => {
  it('validates and persists non-secret settings, same-origin only', async () => {
    const put = (body: unknown, headers: Record<string, string> = {}): Promise<Response> => fetch(`${base}/settings`, { method: 'PUT', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })
    expect((await (await fetch(`${base}/settings`)).json() as { settings: Record<string, string> }).settings).toEqual({ 'replicate.pinned': '', 'hyperframes.cli': '', 'hyperframes.npx': '', 'agent.capture': '' })
    const ok = await put({ 'replicate.pinned': 'a/b c/d', 'hyperframes.cli': '/opt/hf/bin/hyperframes' })
    expect(ok.status).toBe(200); expect((await ok.json() as { settings: Record<string, string> }).settings['replicate.pinned']).toBe('a/b c/d')
    expect((await put({ nope: 'x' })).status).toBe(400)
    expect((await put({ 'agent.capture': '2' })).status).toBe(400)
    expect((await put({ 'agent.capture': '0' })).status).toBe(200)
    expect((await put({ 'hyperframes.npx': '2' })).status).toBe(400)
    expect((await put({ 'hyperframes.cli': 'a\nb' })).status).toBe(400)
    expect((await put({ 'replicate.pinned': 5 })).status).toBe(400)
    expect((await put({ 'replicate.pinned': 'x' }, { origin: 'https://evil.example' })).status).toBe(403)
    expect((await fetch(`${base}/settings`, { method: 'DELETE' })).status).toBe(405)
    expect((await fetch(`${base}/settings`, { method: 'DELETE', headers: { origin: 'https://evil.example' } })).status).toBe(403)
  })

  it('providers carry key-row metadata for known providers and never a secret', async () => {
    const providers = (await (await fetch(`${base}/providers`)).json() as { providers: Record<string, unknown>[] }).providers
    expect(providers[0]).toEqual({ id: 'openrouter', configured: true, label: 'OpenRouter', keyRef: 'OPENROUTER_API_KEY', getKeyUrl: 'https://openrouter.ai/keys', covers: expect.any(String) })
  })
})

describe('mask upload and outpaint preparation', () => {
  const sharpP = import('sharp').then(m => m.default)
  const solidPng = async (w: number, h: number): Promise<Buffer> => (await sharpP)({ create: { width: w, height: h, channels: 3, background: { r: 40, g: 90, b: 200 } } }).png().toBuffer()

  it('normalises an uploaded mask to the source size, tags it and links lineage; rejects bad input', async () => {
    const sharp = await sharpP
    const src = await core.assets.ingestBytes(new Uint8Array(await solidPng(8, 4)), 'image/png', { source: 'generated', title: 'Harbour' })
    const drawn = await sharp(Buffer.from([255, 0, 0, 255]), { raw: { width: 2, height: 2, channels: 1 } }).png().toBuffer()
    const up = (query: string, body: Uint8Array | Buffer, headers: Record<string, string> = { 'content-type': 'image/png' }): Promise<Response> => fetch(`${base}/masks?${query}`, { method: 'POST', headers, body })
    const ok = await up(`source=${src.id}`, drawn)
    expect(ok.status).toBe(201)
    const { asset, stats } = await ok.json() as { asset: { id: string; width: number; height: number; tags: string[]; title: string }; stats: { editedFraction: number } }
    expect([asset.width, asset.height]).toEqual([8, 4]); expect(asset.tags).toEqual(['mask']); expect(asset.title).toBe('Mask for Harbour'); expect(stats.editedFraction).toBe(0.5)
    expect(core.db.parents(asset.id)).toEqual([{ childId: asset.id, parentId: src.id, role: 'source', ord: 0 }])
    expect((await up('source=ZZZZZZZZZZZZZZZZ', drawn)).status).toBe(404)
    expect((await up(`source=${src.id}`, drawn, { 'content-type': 'image/jpeg' })).status).toBe(415)
    expect((await up(`source=${src.id}`, Buffer.from([1, 2, 3]))).status).toBe(400)
    expect((await up(`source=${src.id}`, drawn, { 'content-type': 'image/png', origin: 'https://evil.example' })).status).toBe(403)
  })

  it('expands the canvas into an image + mask pair, ready for an inpaint job (outpaint end to end)', async () => {
    const sharp = await sharpP
    const src = await core.assets.ingestBytes(new Uint8Array(await solidPng(20, 10)), 'image/png', { source: 'generated', title: 'Pier' })
    const res = await post('/assets/expand', { assetId: src.id, right: 10, bottom: 6, overlap: 2 })
    expect(res.status).toBe(201)
    const out = await res.json() as { image: { id: string; width: number; height: number; tags: string[] }; mask: { id: string; width: number; height: number; tags: string[] }; width: number; height: number }
    expect([out.image.width, out.image.height, out.mask.width, out.mask.height]).toEqual([30, 16, 30, 16]); expect(out.image.tags).toEqual(['outpaint']); expect(out.mask.tags).toEqual(['mask'])
    expect(core.db.parents(out.image.id)[0]).toMatchObject({ parentId: src.id, role: 'source' })
    // The pair feeds the normal inpaint path: a model that returns a flat colour only changes the new area.
    const red = await sharp({ create: { width: 30, height: 16, channels: 3, background: { r: 255, g: 0, b: 0 } } }).png().toBuffer()
    const model: ModelDescriptor = { id: 'openrouter:t/outpaint', provider: 'openrouter', remoteId: 'outpaint', label: 'Out', capabilities: ['inpaint'], inputs: {}, params: [], async: 'sync', curated: true }
    const original = adapter.listModels; const originalSubmit = adapter.submit
    adapter.listModels = async () => [model]; adapter.submit = async () => ({ kind: 'done', outputs: [{ bytes: new Uint8Array(red), mediaType: 'image/png' }] })
    try {
      const created = await post('/jobs', { op: 'inpaint', modelId: model.id, prompt: 'continue the pier', inputs: { source: out.image.id, mask: out.mask.id }, params: {} })
      expect(created.status).toBe(202)
      const done = await core.runner.wait((await created.json() as { job: { id: string } }).job.id, 5000)
      expect(done.state).toBe('succeeded')
      const asset = core.db.getAsset(done.assetIds[0]!)!
      const raw = await sharp(await core.blobs.read(asset.sha256, asset.ext)).raw().toBuffer({ resolveWithObject: true })
      const at = (x: number, y: number): number[] => { const i = (y * raw.info.width + x) * raw.info.channels; return [raw.data[i]!, raw.data[i + 1]!, raw.data[i + 2]!] }
      expect(at(25, 3)).toEqual([255, 0, 0])      // new area: repainted
      expect(at(2, 2)).toEqual([40, 90, 200])     // original pixels: untouched
    } finally { adapter.listModels = original; adapter.submit = originalSubmit }
    // Validation: nothing to expand, negative values, absurd sizes, bad ids.
    expect((await post('/assets/expand', { assetId: src.id })).status).toBe(400)
    expect((await post('/assets/expand', { assetId: src.id, left: -4 })).status).toBe(400)
    expect((await post('/assets/expand', { assetId: src.id, right: 9000 })).status).toBe(400)
    expect((await post('/assets/expand', { assetId: 'nope' })).status).toBe(404)
    expect((await post('/assets/expand', { assetId: src.id, right: 5 }, { origin: 'https://evil.example' })).status).toBe(403)
  })
})

describe('legacy import routes', () => {
  const att = { attachmentId: 'att-1', mediaType: 'image/png', bytes: 70, width: 1, height: 1 }
  it('imports a batch host-side, is idempotent, validates size and origin, and reports status', async () => {
    const first = await post('/import-legacy', { items: [{ id: 'g1', attachment: att, prompt: 'old fox', provider: 'grok-sub', model: 'm', isFavorite: true }, { id: 'g2', attachment: { ...att, attachmentId: 'att-gone' } }], prompts: [{ id: 'p', text: 'fav prompt' }] })
    expect(first.status).toBe(200)
    const report = await first.json() as { items: { id: string; status: string }[]; prompts: { imported: number } }
    expect(report.items.map(i => `${i.id}:${i.status}`)).toEqual(['g1:imported', 'g2:missing']); expect(report.prompts.imported).toBe(1)
    expect((await (await post('/import-legacy', { items: [{ id: 'g1', attachment: att }] })).json() as { items: { status: string }[] }).items[0]!.status).toBe('skipped')
    expect((await (await fetch(`${base}/assets?tag=legacy`)).json() as { total: number }).total).toBe(1)
    expect((await post('/import-legacy', { items: Array.from({ length: 26 }, (_, i) => ({ id: `x${String(i)}` })) })).status).toBe(413)
    expect((await post('/import-legacy', { items: [] }, { origin: 'https://evil.example' })).status).toBe(403)
    expect(await (await fetch(`${base}/import-legacy/status`)).json()).toMatchObject({ vaultFiles: 0, importedItems: 1 })
    expect((await post('/import-legacy/vault', {})).status).toBe(200)
  })
})
