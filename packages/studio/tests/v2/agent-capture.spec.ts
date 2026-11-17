import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AgentCapture, callInfoOf, extractMedia, isCollectable } from '../../src/v2/agent-capture.js'
import { readBackfillMarker, runBackfill } from '../../src/v2/agent-backfill.js'
import { createCore, type StudioCore } from '../../src/v2/core.js'

const png = (rgb: [number, number, number]): Promise<Buffer> => sharp({ create: { width: 8, height: 6, channels: 3, background: { r: rgb[0], g: rgb[1], b: rgb[2] } } }).png().toBuffer()
const jpg = (rgb: [number, number, number]): Promise<Buffer> => sharp({ create: { width: 8, height: 6, channels: 3, background: { r: rgb[0], g: rgb[1], b: rgb[2] } } }).jpeg().toBuffer()
const ref = (id: string, bytes: number) => ({ attachmentId: id, mediaType: 'image/png', bytes, width: 8, height: 6 })

let dir: string; let home: string; let workspace: string; let core: StudioCore; let enabled: boolean
const attachments = new Map<string, Uint8Array>(); const warnings: string[] = []
let capture: AgentCapture
const session = () => ({ id: 'sess-1', header: { cwd: workspace } })
const call = (callId: string, name: string, args: unknown) => ({ type: 'tool/call', time: Date.now(), data: { callId, name, arguments: JSON.stringify(args) } })
const result = (callId: string, content: unknown[], isError = false) => ({ type: 'tool/result', time: Date.now(), data: { message: { toolCallId: callId, content, isError } } })
const imageBlock = (id: string, bytes: number) => ({ type: 'image', attachment: ref(id, bytes) })

function mp4(path: string): void {
  execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc=duration=1:size=64x48:rate=5', '-pix_fmt', 'yuv420p', path])
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'studio-agent-')); home = join(dir, 'home'); workspace = join(dir, 'ws'); enabled = true; attachments.clear(); warnings.length = 0
  await mkdir(join(home, 'plugins', 'subscriptions', 'videos'), { recursive: true }); await mkdir(join(home, 'plugins', 'subscriptions', 'images'), { recursive: true }); await mkdir(workspace, { recursive: true })
  core = createCore({ root: join(dir, 'studio') })
  capture = new AgentCapture({ core, home, enabled: () => enabled, logger: { warn: m => { warnings.push(m) } }, readAttachment: async r => { const b = attachments.get(String(r.attachmentId)); if (b === undefined) throw new Error('gone'); return b } })
})
afterEach(async () => { capture.dispose(); await core.close(); await rm(dir, { recursive: true, force: true }) })

const feed = async (events: { type: string; time?: number; data?: unknown }[]): Promise<void> => { for (const e of events) capture.onEvent(session(), e); await capture.idle() }

describe('agent media capture', () => {
  it('collects an image attachment from a foreign tool result with provenance, and is idempotent', async () => {
    const bytes = new Uint8Array(await png([200, 20, 20])); attachments.set('sha256:a', bytes)
    const evts = [call('c1', 'image_generate', { prompt: 'a red fox', provider: 'grok', model: 'grok-imagine' }), result('c1', [{ type: 'text', text: 'Saved 1 image(s)' }, imageBlock('sha256:a', bytes.length)])]
    await feed(evts)
    const list = core.db.queryAssets({ source: 'agent' })
    expect(list.total).toBe(1)
    expect(list.items[0]).toMatchObject({ source: 'agent', kind: 'image', prompt: 'a red fox', provider: 'grok-sub', sessionId: 'sess-1', workspacePath: workspace, origin: { tool: 'image_generate', provider: 'grok', model: 'grok-imagine' } })
    expect(list.items[0]!.tags).toEqual(expect.arrayContaining(['agent', 'image_generate']))
    await feed([call('c2', 'image_generate', { prompt: 'again' }), result('c2', [imageBlock('sha256:a', bytes.length)])])
    expect(core.db.queryAssets({}).total).toBe(1)
    expect(core.db.queryAssets({ fromChats: true }).total).toBe(1)
  })

  it('ignores Studio\'s own tools, viewer tools, errors, and results whose call was never seen', async () => {
    const bytes = new Uint8Array(await png([1, 2, 3])); attachments.set('sha256:b', bytes)
    await feed([call('s1', 'studio_make', {}), result('s1', [imageBlock('sha256:b', bytes.length)])])
    await feed([call('r1', 'read_image', { file_path: '/x.png' }), result('r1', [imageBlock('sha256:b', bytes.length)])])
    await feed([call('e1', 'image_generate', {}), result('e1', [imageBlock('sha256:b', bytes.length)], true)])
    await feed([result('orphan', [imageBlock('sha256:b', bytes.length)])])
    expect(core.db.queryAssets({}).total).toBe(0)
    expect(isCollectable('studio_job')).toBe(false); expect(isCollectable('browser_snapshot')).toBe(false); expect(isCollectable('image_generate')).toBe(true)
  })

  it('does nothing when the setting is off, and starts again when it is switched back on', async () => {
    const bytes = new Uint8Array(await png([9, 9, 9])); attachments.set('sha256:c', bytes)
    enabled = false
    await feed([call('c1', 'image_generate', {}), result('c1', [imageBlock('sha256:c', bytes.length)])])
    expect(core.db.queryAssets({}).total).toBe(0)
    enabled = true
    await feed([call('c2', 'image_generate', {}), result('c2', [imageBlock('sha256:c', bytes.length)])])
    expect(core.db.queryAssets({}).total).toBe(1)
  })

  it('imports a video announced by video_generate from an allowed directory', async () => {
    const path = join(home, 'plugins', 'subscriptions', 'videos', 'video-1.mp4'); mp4(path)
    await feed([call('v1', 'video_generate', { prompt: 'a wave', duration: 3 }), result('v1', [{ type: 'text', text: `Saved video to ${path} (3s)\nTemporary provider URL (expires soon): https://example.invalid/x` }])])
    const found = core.db.queryAssets({ source: 'agent', kind: 'video' })
    expect(found.total).toBe(1)
    expect(found.items[0]).toMatchObject({ kind: 'video', mime: 'video/mp4', prompt: 'a wave', origin: { tool: 'video_generate' } })
    expect(found.items[0]!.posterSha).toBeDefined()
    await feed([call('v2', 'video_generate', {}), result('v2', [{ type: 'text', text: `Saved video to ${path}` }])])
    expect(core.db.queryAssets({}).total).toBe(1)
  })

  it('imports a video from the session workspace but rejects paths outside the allowed roots, symlinks out, wrong extensions, non-video content and oversize files', async () => {
    const inWs = join(workspace, 'out.mp4'); mp4(inWs)
    const outside = join(dir, 'elsewhere.mp4'); mp4(outside)
    await mkdir(join(home, 'plugins', 'subscriptions', 'videos'), { recursive: true })
    const link = join(home, 'plugins', 'subscriptions', 'videos', 'link.mp4'); await symlink(outside, link)
    const fake = join(workspace, 'fake.mp4'); await writeFile(fake, 'not a video at all')
    const wrongExt = join(workspace, 'clip.txt'); mp4(join(workspace, 'tmp.mp4')); await writeFile(wrongExt, 'x')
    const text = (p: string): { type: string; text: string } => ({ type: 'text', text: `Saved video to ${p}` })
    await feed([call('1', 'video_generate', {}), result('1', [text(inWs)])])
    expect(core.db.queryAssets({}).total).toBe(1)
    const before = core.db.queryAssets({}).total
    for (const [i, p] of [outside, link, fake, wrongExt, '/etc/passwd', '../../../etc/passwd', join(workspace, '..', 'elsewhere.mp4')].entries()) await feed([call(`x${String(i)}`, 'video_generate', {}), result(`x${String(i)}`, [text(p)])])
    expect(core.db.queryAssets({}).total).toBe(before)
    const small = new AgentCapture({ core, home, enabled: () => true, limits: { video: 10 }, readAttachment: async () => new Uint8Array() })
    expect(await small.importLocalFile(inWs, { name: 'x', cwd: workspace }, 'video')).toBe('skipped')
    expect(await small.importLocalFile(join(workspace, 'tmp.mp4'), { name: 'x', cwd: workspace }, 'video')).toBe('skipped')
    small.dispose()
  })

  it('never fetches network URLs and a home-directory or root workspace does not widen the allowed roots', async () => {
    expect(extractMedia([{ type: 'text', text: 'Saved video to https://example.invalid/v.mp4' }]).videoPaths).toEqual(['https://example.invalid/v.mp4'])
    expect(await capture.importLocalFile('https://example.invalid/v.mp4', { name: 'x', cwd: workspace }, 'video')).toBe('skipped')
    expect(capture.allowedRoots('/')).toHaveLength(2)
    expect(capture.allowedRoots(undefined)).toHaveLength(2)
    expect(capture.allowedRoots(workspace)).toContain(workspace)
  })

  it('records provenance fields and never throws into the event loop (unreadable attachment, junk args, bad payloads)', async () => {
    expect(callInfoOf('image_generate', '{"prompt":"p","provider":"gpt","model":"m","x":1}')).toEqual({ name: 'image_generate', prompt: 'p', provider: 'gpt', model: 'm' })
    expect(callInfoOf('t', 'not json')).toEqual({ name: 't' })
    for (const bad of [undefined, null, 7, { message: 3 }, { message: { content: 'x' } }]) expect(() => { capture.onEvent(session(), { type: 'tool/result', data: bad }) }).not.toThrow()
    expect(() => { capture.onEvent({ id: 's' }, { type: 'tool/call' }) }).not.toThrow()
    await feed([call('g1', 'image_generate', {}), result('g1', [imageBlock('sha256:missing', 5)])])
    expect(core.db.queryAssets({}).total).toBe(0)
  })

  it('survives the schema upgrade: assets from before the `agent` source keep their rowids and search entries', async () => {
    const bytes = new Uint8Array(await png([5, 6, 7]))
    const old = await core.assets.ingestBytes(bytes, 'image/png', { source: 'generated', prompt: 'blue lighthouse' })
    expect(core.db.queryAssets({ query: 'lighthouse' }).items.map(a => a.id)).toEqual([old.id])
    expect(core.db.queryAssets({ source: 'agent' }).total).toBe(0)
  })
})

describe('agent media backfill', () => {
  it('imports the subscriptions folders as agent media, is idempotent, and never deletes the sources', async () => {
    const images = join(home, 'plugins', 'subscriptions', 'images'); const videos = join(home, 'plugins', 'subscriptions', 'videos')
    await writeFile(join(images, 'image-1.jpg'), await jpg([10, 10, 10])); await writeFile(join(images, 'image-2.jpg'), await jpg([90, 20, 20])); await writeFile(join(images, 'notes.txt'), 'x')
    mp4(join(videos, 'video-1.mp4'))
    expect(readBackfillMarker(core)).toBeUndefined()
    const first = await runBackfill(core, capture, { home, yieldMs: 0 })
    expect(first).toMatchObject({ imported: 3, alreadyThere: 0, filesScanned: 3 })
    expect(core.db.queryAssets({ source: 'agent' }).total).toBe(3)
    expect(core.db.queryAssets({ source: 'agent', kind: 'video' }).total).toBe(1)
    expect(readBackfillMarker(core)?.summary.imported).toBe(3)
    const second = await runBackfill(core, capture, { home, yieldMs: 0 })
    expect(second).toMatchObject({ imported: 0, alreadyThere: 3 })
    expect(core.db.queryAssets({}).total).toBe(3)
    const { readdir } = await import('node:fs/promises')
    expect((await readdir(images)).sort()).toEqual(['image-1.jpg', 'image-2.jpg', 'notes.txt']); expect(await readdir(videos)).toEqual(['video-1.mp4'])
  })

  it('reads existing chats through the history face (session, prompt, model from the matching call), and a deleted asset is not resurrected', async () => {
    const bytes = new Uint8Array(await png([33, 44, 55])); attachments.set('sha256:h', bytes)
    const events = [call('c1', 'image_generate', { prompt: 'old chat prompt', model: 'gpt-image-2' }), result('c1', [imageBlock('sha256:h', bytes.length)]), call('c2', 'studio_make', {}), result('c2', [imageBlock('sha256:h', bytes.length)])]
    const history = { list: async () => [{ id: 'old-session', cwd: workspace }], read: async () => ({ cwd: workspace, events }) }
    const s = await runBackfill(core, capture, { home, history, yieldMs: 0 })
    expect(s).toMatchObject({ imported: 1, sessionsScanned: 1 })
    const asset = core.db.queryAssets({ source: 'agent' }).items[0]!
    expect(asset).toMatchObject({ sessionId: 'old-session', prompt: 'old chat prompt', origin: { tool: 'image_generate', model: 'gpt-image-2' } })
    await core.assets.softDelete(asset.id)
    const again = await runBackfill(core, capture, { home, history, yieldMs: 0 })
    expect(again.imported).toBe(0)
    expect(core.db.queryAssets({}).total).toBe(0)
  })

  it('one unreadable session does not stop the rest', async () => {
    const bytes = new Uint8Array(await png([70, 80, 90])); attachments.set('sha256:k', bytes)
    const history = { list: async () => [{ id: 'bad' }, { id: 'good', cwd: workspace }], read: async (id: string) => { if (id === 'bad') throw new Error('corrupt'); return { cwd: workspace, events: [call('c', 'image_generate', {}), result('c', [imageBlock('sha256:k', bytes.length)])] } } }
    const s = await runBackfill(core, capture, { home, history, yieldMs: 0 })
    expect(s.imported).toBe(1); expect(s.failed).toBe(1)
  })
})
