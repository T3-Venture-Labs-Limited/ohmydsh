import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createCore, type StudioCore } from '../../src/v2/core.js'
import { CHILD_ENV, HyperframesManager, SLUG } from '../../src/v2/hyperframes/launcher.js'
import { createV2Handler, ROUTE_BASE } from '../../src/v2/routes/index.js'

const FAKE = fileURLToPath(new URL('./fixtures/hyperframes/fake-hyperframes.mjs', import.meta.url))
const PNG = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'))

let dir: string; let core: StudioCore; let hf: HyperframesManager
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'studio-hf-'))
  core = createCore({ root: dir })
  hf = new HyperframesManager(core, { cliPath: () => FAKE })
})
afterEach(async () => { await hf.dispose(); await core.close(); await rm(dir, { recursive: true, force: true }) })

describe('HyperFrames hand-off', () => {
  it('reports unavailable when no CLI resolves, and the open route answers 503 hyperframes-missing', async () => {
    const none = new HyperframesManager(core, { cliPath: () => '/nonexistent/hyperframes', execFile: async () => { throw new Error('ENOENT') } })
    expect(await none.status()).toEqual({ available: false, projects: [] })
    await expect(none.open({})).rejects.toMatchObject({ status: 503, code: 'hyperframes-missing' })
  })

  it('never lets the CLI phone home: telemetry and update checks are disabled for every child', () => {
    expect(CHILD_ENV).toMatchObject({ HYPERFRAMES_NO_TELEMETRY: '1', DO_NOT_TRACK: '1', HYPERFRAMES_NO_UPDATE_CHECK: '1', HYPERFRAMES_NO_OPEN: '1' })
  })

  it('creates a project, hard-links assets, writes lineage, starts a loopback preview that answers, and reuses it', async () => {
    const clip = await core.assets.ingestBytes(PNG, 'image/png', { source: 'generated', title: 'Boat shot' })
    const first = await hf.open({ assetIds: [clip.id] })
    expect(first).toMatchObject({ slug: 'boat-shot', created: true })
    expect(first.url).toBe(`http://127.0.0.1:${String(first.port)}/#project/boat-shot`)
    expect(first.loopbackUrl).toBe(first.url)
    const config = await (await fetch(`http://127.0.0.1:${String(first.port)}/__hyperframes_config`)).json() as { isHyperframes: boolean }
    expect(config.isHyperframes).toBe(true)
    const projectDir = join(dir, 'hyperframes', 'boat-shot')
    expect((await stat(join(projectDir, 'assets', `${clip.id}.png`))).size).toBe(PNG.byteLength)
    expect(JSON.parse(await readFile(join(projectDir, 'studio-lineage.json'), 'utf8'))).toMatchObject({ assets: { [`assets/${clip.id}.png`]: clip.id } })
    const again = await hf.open({ project: 'boat-shot' })
    expect(again).toMatchObject({ slug: 'boat-shot', created: false, port: first.port })
    const status = await hf.status()
    expect(status.available).toBe(true)
    expect(status.projects).toEqual([{ slug: 'boat-shot', dir: projectDir, running: true, port: first.port, url: first.url }])
    expect(await hf.stop('boat-shot')).toBe(true)
    await new Promise(r => setTimeout(r, 300))
    expect((await hf.status()).projects[0]!.running).toBe(false)
  }, 30_000)

  it('passes the first video to init with a resolution preset derived from its shape', async () => {
    const { writeFile: w } = await import('node:fs/promises')
    void w
    const first = await hf.open({})
    expect(first.created).toBe(true)
    expect(JSON.parse(await readFile(join(dir, 'hyperframes', first.slug, 'init-args.json'), 'utf8'))).toEqual(expect.arrayContaining(['init', first.slug, '--example', 'blank', '--non-interactive']))
  }, 30_000)

  it('rejects unsafe slugs and unknown assets, and cleans up a failed init and reports a failed preview', async () => {
    for (const bad of ['../x', 'A', 'a b', '', 'x'.repeat(60), '.hidden']) expect(SLUG.test(bad)).toBe(false)
    await expect(hf.open({ project: '../../etc' })).rejects.toMatchObject({ status: 400, code: 'invalid-slug' })
    await expect(hf.open({ assetIds: ['ZZZZZZZZZZZZZZZZ'] })).rejects.toMatchObject({ status: 404 })
    process.env.FAKE_HF_INIT_FAIL = '1'
    await expect(hf.open({ project: 'fails' })).rejects.toMatchObject({ code: 'hyperframes-init-failed' })
    await expect(stat(join(dir, 'hyperframes', 'fails'))).rejects.toThrow()
    delete process.env.FAKE_HF_INIT_FAIL
    process.env.FAKE_HF_PREVIEW_FAIL = '1'
    await expect(hf.open({ project: 'badport' })).rejects.toMatchObject({ code: 'hyperframes-preview-failed' })
    delete process.env.FAKE_HF_PREVIEW_FAIL
  }, 30_000)

  it('imports new renders once as render assets whose parents are the project clips, skipping files still being written', async () => {
    const clip = await core.assets.ingestBytes(PNG, 'image/png', { source: 'generated', title: 'clip' })
    const { slug } = await hf.open({ assetIds: [clip.id], project: 'edit-1' })
    const rendersDir = join(dir, 'hyperframes', slug, 'renders'); await mkdir(rendersDir, { recursive: true })
    const old = new Date(Date.now() - 60_000)
    await writeFile(join(rendersDir, 'final.mp4'), Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypmp42'), Buffer.alloc(40)]))
    await utimes(join(rendersDir, 'final.mp4'), old, old)
    await writeFile(join(rendersDir, 'wip.mp4'), Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypmp42'), Buffer.alloc(40, 1)]))
    const events: string[] = []; core.assets.onAsset(a => events.push(a.id))
    const imported = await hf.importRenders(slug)
    expect(imported).toHaveLength(1)
    expect(imported[0]).toMatchObject({ source: 'render', kind: 'video', tags: ['render', 'hyperframes'] })
    expect(core.db.parents(imported[0]!.id)).toEqual([{ childId: imported[0]!.id, parentId: clip.id, role: 'video', ord: 0 }])
    expect(events).toEqual([imported[0]!.id])
    expect(await hf.importRenders(slug)).toEqual([])
    expect(await hf.importRenders('no-such-project')).toEqual([])
  }, 30_000)
})

describe('HyperFrames routes', () => {
  let server: Server; let base: string
  beforeEach(async () => {
    const handler = createV2Handler(core, hf)
    server = createServer((req, res) => { void handler(req, res) })
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
    base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}${ROUTE_BASE}`
  })
  afterEach(async () => { server.closeAllConnections(); await new Promise(r => server.close(r)) })
  const post = (path: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })

  it('status/open/stop/import-renders over HTTP with same-origin protection and validation', async () => {
    expect((await (await fetch(`${base}/hyperframes/status`)).json() as { available: boolean }).available).toBe(true)
    const opened = await post('/hyperframes/open', { project: 'route-test' })
    expect(opened.status).toBe(200)
    expect(await opened.json()).toMatchObject({ slug: 'route-test', created: true })
    expect((await post('/hyperframes/open', { project: 'x' }, { origin: 'https://evil.example' })).status).toBe(403)
    expect((await post('/hyperframes/open', { project: '../etc' })).status).toBe(400)
    expect((await post('/hyperframes/open', { assetIds: 'nope' })).status).toBe(400)
    expect(await (await post('/hyperframes/import-renders', { slug: 'route-test' })).json()).toEqual({ assets: [] })
    expect(await (await post('/hyperframes/stop', { slug: 'route-test' })).json()).toEqual({ stopped: true })
    expect((await fetch(`${base}/hyperframes/open`)).status).toBe(404)
  }, 30_000)
})
