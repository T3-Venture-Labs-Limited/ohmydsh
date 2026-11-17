/**
 * Gallery capture of media the agent makes in any chat.
 *
 * Agents also generate through tools Studio does not own (`image_generate`, `video_generate`, MCP tools, ...). This module watches the
 * durable `session/event` feed and copies every image attachment and every announced local video into the Studio gallery with provenance
 * (tool, session, workspace, prompt, provider/model the agent asked for). Content addressing makes it idempotent: a file whose bytes are
 * already stored is "already there", and a hash that was captured once is remembered so a gallery deletion is never undone.
 *
 * It runs off the event path with bounded concurrency and a bounded queue, never throws into the event loop, and logs failures once
 * per kind without content. It never follows a path outside the allowed roots and never fetches a URL.
 */
import { realpath, stat } from 'node:fs/promises'
import { extname, join, sep } from 'node:path'
import { homedir } from 'node:os'
import { parseImageAttachmentRef } from '../reference-image.js'
import { resolveDshHome } from '../vault-store.js'
import { sniffMediaType, sha256Of } from './assets/blobs.js'
import type { AssetOrigin, ProviderId } from './contracts.js'
import type { StudioCore } from './core.js'

export const MAX_AGENT_IMAGE_BYTES = 100 * 1024 * 1024
export const MAX_AGENT_VIDEO_BYTES = 512 * 1024 * 1024
export const VIDEO_EXTENSIONS: readonly string[] = ['.mp4', '.webm', '.mov', '.mkv']
export const IMAGE_EXTENSIONS: readonly string[] = ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.avif']
const MAX_QUEUE = 200
const CONCURRENCY = 2
const MAX_PENDING_CALLS = 500
const PROVIDER_ALIASES: Readonly<Record<string, ProviderId>> = { grok: 'grok-sub' }
const PROVIDER_IDS: readonly string[] = ['openrouter', 'replicate', 'google', 'grok-sub', 'google-sub', 'comfyui', 'openai', 'openai-compat', 'xai']
/** The only settings key prefix this module writes: `agent-seen:<sha256>` → asset id. */
export const SEEN_PREFIX = 'agent-seen:'

export type CaptureOutcome = 'imported' | 'already' | 'skipped' | 'failed'
export interface CaptureTally { imported: number; alreadyThere: number; skipped: number; failed: number }
export const emptyTally = (): CaptureTally => ({ imported: 0, alreadyThere: 0, skipped: 0, failed: 0 })
export function addOutcome(tally: CaptureTally, outcome: CaptureOutcome): void {
  if (outcome === 'imported') tally.imported++; else if (outcome === 'already') tally.alreadyThere++; else if (outcome === 'skipped') tally.skipped++; else tally.failed++
}

export interface CallInfo { name: string; prompt?: string; provider?: string; model?: string }
export interface Provenance extends CallInfo { sessionId?: string; cwd?: string; time?: number }

export interface CaptureDeps {
  core: StudioCore
  enabled(): boolean
  readAttachment(ref: ReturnType<typeof parseImageAttachmentRef> & object): Promise<Uint8Array>
  logger?: { warn(message: string): void; debug?(message: string): void }
  home?: string
  /** Test hooks. */
  limits?: { image?: number; video?: number }
}

/** Loose face of the session event data this module reads. */
interface ToolResultData { message?: { toolCallId?: unknown; content?: unknown; isError?: boolean } }
interface ToolCallData { callId?: unknown; name?: unknown; arguments?: unknown }
export interface EventView { type: string; time?: number; data?: unknown }
export interface SessionView { id: string; header?: { cwd?: string } }

const str = (value: unknown, max: number): string | undefined => (typeof value === 'string' && value.trim().length > 0 ? value.trim().slice(0, max) : undefined)

/** Pull what is worth keeping out of a tool call's raw JSON arguments. Never throws. */
export function callInfoOf(name: string, rawArguments: unknown): CallInfo {
  const info: CallInfo = { name: name.slice(0, 80) }
  if (typeof rawArguments !== 'string' || rawArguments.length > 200_000) return info
  try {
    const args = JSON.parse(rawArguments) as Record<string, unknown>
    const prompt = str(args.prompt, 8000); const provider = str(args.provider, 60); const model = str(args.model, 120)
    if (prompt !== undefined) info.prompt = prompt
    if (provider !== undefined) info.provider = provider
    if (model !== undefined) info.model = model
  } catch { /* the arguments are the model's raw text: unreadable ones simply give no provenance */ }
  return info
}

/** Media a tool result announces: image attachments, and local video paths from "Saved video to <path>" lines. */
export function extractMedia(content: unknown): { images: unknown[]; videoPaths: string[] } {
  const images: unknown[] = []; const videoPaths: string[] = []
  if (!Array.isArray(content)) return { images, videoPaths }
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    const b = block as { type?: unknown; attachment?: unknown; text?: unknown }
    if (b.type === 'image' && b.attachment !== undefined) images.push(b.attachment)
    else if (b.type === 'text' && typeof b.text === 'string' && b.text.length < 100_000) {
      for (const match of b.text.matchAll(/^Saved video to (.+?)(?: \([\d.]+s\))?\s*$/gm)) { const p = match[1]!.trim(); if (p.length > 0 && p.length < 1024) videoPaths.push(p) }
    }
  }
  return { images, videoPaths }
}

export class AgentCapture {
  private readonly calls = new Map<string, CallInfo>()
  private queue: (() => Promise<void>)[] = []
  private running = 0
  private warned = new Set<string>()
  private readonly startedAt = Date.now()
  private disposed = false

  constructor(private readonly deps: CaptureDeps) {}

  dispose(): void { this.disposed = true; this.queue = []; this.calls.clear() }

  /** Feed one `session/event`. Synchronous and exception-free: the real work is queued. */
  onEvent(session: SessionView, event: EventView): void {
    try {
      if (this.disposed || (event.type !== 'tool/call' && event.type !== 'tool/result')) return
      if (!this.deps.enabled()) return
      if (typeof event.time === 'number' && event.time < this.startedAt - 1000) return
      if (event.type === 'tool/call') {
        const d = event.data as ToolCallData; if (typeof d?.callId !== 'string' || typeof d.name !== 'string') return
        this.calls.set(`${session.id}:${d.callId}`, callInfoOf(d.name, d.arguments))
        if (this.calls.size > MAX_PENDING_CALLS) this.calls.delete(this.calls.keys().next().value as string)
        return
      }
      if (event.type !== 'tool/result') return
      const message = (event.data as ToolResultData | undefined)?.message
      const callId = message?.toolCallId
      const key = typeof callId === 'string' ? `${session.id}:${callId}` : undefined
      const call = key === undefined ? undefined : this.calls.get(key)
      if (key !== undefined) this.calls.delete(key)
      if (message === undefined || message.isError === true) return
      // A result whose call was not seen cannot be attributed, so it is not collected (viewer tools look the same as makers).
      if (call === undefined || !isCollectable(call.name)) return
      const media = extractMedia(message.content)
      if (media.images.length === 0 && media.videoPaths.length === 0) return
      const provenance: Provenance = { ...call, sessionId: session.id, ...(session.header?.cwd === undefined ? {} : { cwd: session.header.cwd }), ...(event.time === undefined ? {} : { time: event.time }) }
      this.enqueue(async () => { await this.collect(media, provenance) })
    } catch (error) { this.warnOnce('event', error) }
  }

  /** Import every image attachment and announced video of one tool result. Resolves with the per-item outcomes. */
  async collect(media: { images: unknown[]; videoPaths: string[] }, provenance: Provenance): Promise<CaptureOutcome[]> {
    const outcomes: CaptureOutcome[] = []
    for (const raw of media.images) outcomes.push(await this.importAttachment(raw, provenance))
    for (const path of media.videoPaths) outcomes.push(await this.importLocalFile(path, provenance, 'video'))
    return outcomes
  }

  async importAttachment(raw: unknown, provenance: Provenance): Promise<CaptureOutcome> {
    const ref = parseImageAttachmentRef(raw)
    if (ref === undefined) return 'skipped'
    try {
      const bytes = await this.deps.readAttachment(ref).catch(() => undefined)
      if (bytes === undefined) return 'skipped'
      if (bytes.byteLength > (this.deps.limits?.image ?? MAX_AGENT_IMAGE_BYTES)) return 'skipped'
      return await this.store(sha256Of(bytes), provenance, meta => this.deps.core.assets.ingestBytes(bytes, ref.mediaType, meta))
    } catch (error) { this.warnOnce('image', error); return 'failed' }
  }

  /**
   * Import one local file (a video announced by a tool, or a file found by the backfill). The path must resolve, through symlinks, into an
   * allowed root: the subscriptions media folders or the session's own workspace.
   */
  async importLocalFile(path: string, provenance: Provenance, kind: 'video' | 'image'): Promise<CaptureOutcome> {
    try {
      const real = await this.resolveAllowed(path, provenance.cwd, kind)
      if (real === undefined) return 'skipped'
      const size = (await stat(real)).size
      if (size > (kind === 'video' ? (this.deps.limits?.video ?? MAX_AGENT_VIDEO_BYTES) : (this.deps.limits?.image ?? MAX_AGENT_IMAGE_BYTES))) return 'skipped'
      const { core } = this.deps
      if (kind === 'video') {
        return await this.store(await core.blobs.hashFile(real), provenance, meta => core.assets.ingestFile(real, meta))
      }
      const { readFile } = await import('node:fs/promises')
      const bytes = new Uint8Array(await readFile(real))
      if (sniffMediaType(bytes)?.startsWith('image/') !== true) return 'skipped'
      return await this.store(sha256Of(bytes), provenance, meta => core.assets.ingestBytes(bytes, undefined, meta))
    } catch (error) { this.warnOnce(kind, error); return 'failed' }
  }

  /** Roots an announced path may live in. */
  allowedRoots(cwd: string | undefined): string[] {
    const home = resolveDshHome(this.deps.home)
    const roots = [join(home, 'plugins', 'subscriptions', 'videos'), join(home, 'plugins', 'subscriptions', 'images')]
    // A workspace of "/" or the whole home directory would allow almost anything: only narrower folders count.
    if (cwd !== undefined && cwd.startsWith('/') && cwd !== '/' && cwd.replace(/\/+$/, '') !== homedir().replace(/\/+$/, '')) roots.push(cwd)
    return roots
  }

  private async resolveAllowed(path: string, cwd: string | undefined, kind: 'video' | 'image'): Promise<string | undefined> {
    if (!path.startsWith('/') || path.includes('\0')) return undefined
    if (!(kind === 'video' ? VIDEO_EXTENSIONS : IMAGE_EXTENSIONS).includes(extname(path).toLowerCase())) return undefined
    let real: string
    try { real = await realpath(path) } catch { return undefined }
    if (!(await stat(real)).isFile()) return undefined
    for (const root of this.allowedRoots(cwd)) {
      let realRoot: string
      try { realRoot = await realpath(root) } catch { continue }
      if (real.startsWith(realRoot.endsWith(sep) ? realRoot : realRoot + sep)) return real
    }
    return undefined
  }

  /** Dedupe on content, then store with provenance. `create` receives the full ingest metadata. */
  private async store(sha: string, p: Provenance, create: (meta: Parameters<StudioCore['assets']['ingestBytes']>[2]) => Promise<{ id: string }>): Promise<CaptureOutcome> {
    const { db } = this.deps.core
    if (db.getSetting(SEEN_PREFIX + sha) !== undefined || db.findBySha(sha) !== undefined) return 'already'
    const origin: AssetOrigin = { tool: p.name, ...(p.provider === undefined ? {} : { provider: p.provider }), ...(p.model === undefined ? {} : { model: p.model }) }
    const alias = p.provider === undefined ? undefined : PROVIDER_ALIASES[p.provider] ?? (PROVIDER_IDS.includes(p.provider) ? p.provider as ProviderId : undefined)
    const tag = p.name.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').slice(0, 40)
    const asset = await create({
      source: 'agent', origin, tags: ['agent', ...(tag === '' || tag === 'agent' ? [] : [tag])],
      ...(p.prompt === undefined ? {} : { prompt: p.prompt }), ...(alias === undefined ? {} : { provider: alias }),
      ...(p.sessionId === undefined ? {} : { sessionId: p.sessionId.slice(0, 120) }), ...(p.cwd === undefined ? {} : { workspacePath: p.cwd.slice(0, 500) }),
      ...(p.time === undefined ? {} : { createdAt: p.time }),
    })
    db.setSetting(SEEN_PREFIX + sha, asset.id)
    return 'imported'
  }

  private enqueue(job: () => Promise<void>): void {
    if (this.queue.length >= MAX_QUEUE) { this.warnOnce('queue', new Error('capture queue is full; some agent media was not collected')); return }
    this.queue.push(job); this.pump()
  }

  private pump(): void {
    while (this.running < CONCURRENCY && this.queue.length > 0 && !this.disposed) {
      const job = this.queue.shift()!
      this.running++
      void job().catch(error => { this.warnOnce('job', error) }).finally(() => { this.running--; this.pump() })
    }
  }

  /** Resolves when everything queued so far has finished (tests, shutdown). */
  async idle(): Promise<void> { while (this.running > 0 || this.queue.length > 0) await new Promise(r => setTimeout(r, 5)) }

  private warnOnce(kind: string, error: unknown): void {
    // Messages from fs/sqlite never contain media content; the class and message are enough.
    if (this.warned.has(kind)) { this.deps.logger?.debug?.(`dsh-studio: agent media capture (${kind}) failed again`); return }
    this.warned.add(kind)
    this.deps.logger?.warn(`dsh-studio: agent media capture (${kind}) failed: ${error instanceof Error ? error.message.slice(0, 200) : 'unknown error'}`)
  }
}

export const isStudioTool = (name: string): boolean => name.startsWith('studio_')

/**
 * Tools that only LOOK at images (reading a file, a page, a screen, a video) return image attachments too, but those are not things
 * the agent made. They are never collected, or every screenshot and every viewed photo would flood the gallery.
 */
const VIEWER_TOOL = /^(read|read_image|view_image|look_video|web_fetch|web_search|x_search|screenshot|computer.*|.*screenshot.*|browser_.*|terminal_browser.*|.*browser.*snapshot.*)$/i
export const isViewerTool = (name: string): boolean => VIEWER_TOOL.test(name)
export const isCollectable = (name: string): boolean => !isStudioTool(name) && !isViewerTool(name)
