/**
 * HyperFrames hand-off: project folders under <studio root>/hyperframes/<slug>, a managed loopback `hyperframes preview`
 * per project, and import of finished renders back into the gallery as lineage children.
 * Security: no shell (argv arrays only), slugs are validated, the preview binds to 127.0.0.1 on a free port, children are
 * killed on dispose, and project paths never leave the studio root.
 */
import { spawn, execFile, type ChildProcess } from 'node:child_process'
import { copyFile, link, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { join, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import type { AssetRecord } from '../contracts.js'
import type { StudioCore } from '../core.js'

const run = promisify(execFile)
export const PINNED_VERSION = '0.9.41'
/** The CLI phones home (PostHog) and checks for updates by default; a plugin must not opt the user into either. */
export const CHILD_ENV: Readonly<Record<string, string>> = { HYPERFRAMES_NO_TELEMETRY: '1', DO_NOT_TRACK: '1', HYPERFRAMES_NO_UPDATE_CHECK: '1', HYPERFRAMES_NO_OPEN: '1', HYPERFRAMES_NO_AUTO_INSTALL: '1' }
export const SLUG = /^[a-z0-9][a-z0-9-]{0,47}$/

export interface HyperframesOptions {
  /** Explicit CLI path from settings. */
  cliPath?: () => string | undefined
  /** Injectable for tests. */
  spawn?: typeof spawn
  execFile?: (file: string, args: string[], options: { cwd?: string; timeout: number }) => Promise<{ stdout: string; stderr: string }>
  fetch?: typeof fetch
  now?: () => number
  logger?: { warn(m: string): void; info?(m: string): void }
  /** Stop a preview after this long without a use (default 30 min). */
  idleMs?: number
  allowNpx?: () => boolean
}

export interface ProjectInfo { slug: string; dir: string; running: boolean; url?: string; port?: number }

interface Running { child: ChildProcess; port: number; lastUsed: number }

export class HyperframesManager {
  private readonly running = new Map<string, Running>()
  private cli: { cmd: string; args: string[] } | null | undefined
  private idleTimer: ReturnType<typeof setInterval> | undefined

  constructor(private readonly core: StudioCore, private readonly options: HyperframesOptions = {}) {}

  get projectsRoot(): string { return join(this.core.root, 'hyperframes') }
  projectDir(slug: string): string {
    if (!SLUG.test(slug)) throw new HfError(400, 'invalid-slug', 'Project names use lowercase letters, digits and dashes')
    const dir = resolve(this.projectsRoot, slug)
    if (!dir.startsWith(resolve(this.projectsRoot) + sep)) throw new HfError(400, 'invalid-slug')
    return dir
  }

  // ------------------------------------------------------------------ CLI resolution
  /** Find the CLI once: settings path -> `hyperframes` on PATH -> `npx -y hyperframes@<pinned>` (when allowed). */
  async resolveCli(): Promise<{ cmd: string; args: string[] } | null> {
    if (this.cli !== undefined) return this.cli
    const exec = this.options.execFile ?? ((f, a, o) => run(f, a, { ...o, maxBuffer: 1024 * 1024, env: { ...process.env, ...CHILD_ENV } }))
    const candidates: { cmd: string; args: string[] }[] = []
    const configured = this.options.cliPath?.()
    if (configured !== undefined && configured.trim().length > 0) candidates.push({ cmd: configured.trim(), args: [] })
    candidates.push({ cmd: 'hyperframes', args: [] })
    for (const c of candidates) {
      try { await exec(c.cmd, [...c.args, '--version'], { timeout: 20_000 }); return (this.cli = c) } catch { /* try next */ }
    }
    if (this.options.allowNpx?.() === true) {
      const c = { cmd: 'npx', args: ['-y', `hyperframes@${PINNED_VERSION}`] }
      try { await exec(c.cmd, [...c.args, '--version'], { timeout: 120_000 }); return (this.cli = c) } catch { /* unavailable */ }
    }
    return (this.cli = null)
  }

  /** Forget a failed resolution (after the user installs the CLI). */
  resetCli(): void { this.cli = undefined }

  // ------------------------------------------------------------------ status
  async status(): Promise<{ available: boolean; cli?: string; projects: ProjectInfo[] }> {
    const cli = await this.resolveCli()
    const projects: ProjectInfo[] = []
    try {
      for (const entry of await readdir(this.projectsRoot, { withFileTypes: true })) {
        if (!entry.isDirectory() || !SLUG.test(entry.name)) continue
        const r = this.running.get(entry.name)
        projects.push({ slug: entry.name, dir: join(this.projectsRoot, entry.name), running: r !== undefined, ...(r === undefined ? {} : { port: r.port, url: urlFor(r.port, entry.name) }) })
      }
    } catch { /* no projects yet */ }
    return { available: cli !== null, ...(cli === null ? {} : { cli: [cli.cmd, ...cli.args].join(' ') }), projects }
  }

  // ------------------------------------------------------------------ open
  /** Create (or reuse) a project, place the assets, start its preview and return the Studio URL. */
  async open(input: { assetIds?: readonly string[]; project?: string }, signal?: AbortSignal): Promise<{ slug: string; url: string; loopbackUrl: string; port: number; created: boolean }> {
    const cli = await this.resolveCli()
    if (cli === null) throw new HfError(503, 'hyperframes-missing', 'The HyperFrames CLI was not found. Install it with `npm i -g hyperframes` and try again.')
    const assets = (input.assetIds ?? []).map(id => {
      const a = this.core.db.getAsset(id)
      if (a === undefined || a.deletedAt !== undefined) throw new HfError(404, 'asset-not-found', `Asset ${id} was not found`)
      return a
    })
    const slug = input.project ?? await this.newSlug(assets[0])
    const dir = this.projectDir(slug)
    let created = false
    if (!(await exists(join(dir, 'index.html')))) {
      created = true
      await mkdir(this.projectsRoot, { recursive: true })
      await this.init(cli, slug, assets.find(a => a.kind === 'video'), signal)
    }
    await this.placeAssets(dir, assets)
    const port = await this.ensurePreview(cli, slug, dir, signal)
    const url = urlFor(port, slug)
    return { slug, url, loopbackUrl: url, port, created }
  }

  private async newSlug(first: AssetRecord | undefined): Promise<string> {
    const base = ((first?.title ?? first?.prompt ?? 'project').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 28)) || 'project'
    for (let i = 0; i < 100; i++) {
      const slug = i === 0 ? base : `${base}-${String(i + 1)}`
      if (!(await exists(join(this.projectsRoot, slug)))) return slug
    }
    return `${base}-${Date.now().toString(36)}`
  }

  private async init(cli: { cmd: string; args: string[] }, slug: string, video: AssetRecord | undefined, signal?: AbortSignal): Promise<void> {
    const exec = this.options.execFile ?? ((f, a, o) => run(f, a, { ...o, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, ...CHILD_ENV }, ...(signal === undefined ? {} : { signal }) }))
    const args = [...cli.args, 'init', slug, '--example', 'blank', '--non-interactive', '--skip-skills', '--skip-transcribe']
    if (video !== undefined) {
      args.push('--video', this.core.assets.pathOf(video))
      const w = video.width; const h = video.height
      if (w !== undefined && h !== undefined) args.push('--resolution', w === h ? 'square' : w > h ? 'landscape' : 'portrait')
    }
    try { await exec(cli.cmd, args, { cwd: this.projectsRoot, timeout: 180_000 }) } catch (error) {
      await rm(join(this.projectsRoot, slug), { recursive: true, force: true })
      throw new HfError(502, 'hyperframes-init-failed', `hyperframes init failed: ${error instanceof Error ? error.message.slice(0, 300) : String(error)}`)
    }
  }

  /** Put each asset into <project>/assets (hard link when possible) and record which asset each file came from. */
  private async placeAssets(dir: string, assets: readonly AssetRecord[]): Promise<void> {
    if (assets.length === 0) return
    const lineagePath = join(dir, 'studio-lineage.json')
    let lineage: { assets: Record<string, string>; imported: string[] } = { assets: {}, imported: [] }
    try { lineage = { ...lineage, ...(JSON.parse(await readFile(lineagePath, 'utf8')) as typeof lineage) } } catch { /* first time */ }
    await mkdir(join(dir, 'assets'), { recursive: true })
    for (const a of assets) {
      const name = `${a.id}.${a.ext}`
      const target = join(dir, 'assets', name)
      if (!(await exists(target))) {
        const source = this.core.assets.pathOf(a)
        try { await link(source, target) } catch { await copyFile(source, target) }
      }
      lineage.assets[`assets/${name}`] = a.id
    }
    await writeFile(lineagePath, JSON.stringify(lineage, null, 2))
  }

  // ------------------------------------------------------------------ preview process
  private async ensurePreview(cli: { cmd: string; args: string[] }, slug: string, dir: string, signal?: AbortSignal): Promise<number> {
    const existing = this.running.get(slug)
    if (existing !== undefined && existing.child.exitCode === null && await this.answers(existing.port)) { existing.lastUsed = this.now(); return existing.port }
    this.running.delete(slug)
    const port = await freePort()
    const spawnFn = this.options.spawn ?? spawn
    // --foreground keeps the child attached to us (so we own its lifetime); --no-open never launches a browser.
    const child = spawnFn(cli.cmd, [...cli.args, 'preview', dir, '--foreground', '--no-open', '--port', String(port)], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...CHILD_ENV }, shell: false })
    let tail = ''
    const keep = (b: Buffer): void => { tail = (tail + b.toString()).slice(-600) }
    child.stdout?.on('data', keep); child.stderr?.on('data', keep)
    const exited = new Promise<never>((_, reject) => { child.once('exit', code => { reject(new HfError(502, 'hyperframes-preview-failed', `hyperframes preview exited with code ${String(code)}: ${tail.trim().slice(-200)}`)) }); child.once('error', e => { reject(new HfError(502, 'hyperframes-preview-failed', e.message)) }) })
    exited.catch(() => undefined)
    const started = this.now()
    for (;;) {
      if (signal?.aborted === true) { child.kill(); throw signal.reason }
      if (await Promise.race([this.answers(port), exited.catch((e: unknown) => { throw e })])) break
      if (this.now() - started > 60_000) { child.kill(); throw new HfError(504, 'hyperframes-preview-timeout', 'The preview server did not start within 60 s') }
      await sleep(250)
    }
    this.running.set(slug, { child, port, lastUsed: this.now() })
    child.once('exit', () => { if (this.running.get(slug)?.child === child) this.running.delete(slug) })
    this.startIdleWatch()
    return port
  }

  private async answers(port: number): Promise<boolean> {
    try {
      const r = await (this.options.fetch ?? fetch)(`http://127.0.0.1:${String(port)}/__hyperframes_config`, { signal: AbortSignal.timeout(1500) })
      if (!r.ok) return false
      const body = await r.json() as { isHyperframes?: boolean }
      return body.isHyperframes === true
    } catch { return false }
  }

  private startIdleWatch(): void {
    if (this.idleTimer !== undefined) return
    this.idleTimer = setInterval(() => {
      for (const [slug, r] of this.running) if (this.now() - r.lastUsed > (this.options.idleMs ?? 30 * 60_000)) void this.stop(slug)
    }, 60_000)
    this.idleTimer.unref?.()
  }

  async stop(slug: string): Promise<boolean> {
    this.projectDir(slug)
    const r = this.running.get(slug)
    if (r === undefined) return false
    this.running.delete(slug)
    r.child.kill('SIGTERM')
    setTimeout(() => { if (r.child.exitCode === null) r.child.kill('SIGKILL') }, 4000).unref()
    return true
  }

  async dispose(): Promise<void> {
    if (this.idleTimer !== undefined) clearInterval(this.idleTimer)
    for (const slug of [...this.running.keys()]) await this.stop(slug)
  }

  private now(): number { return (this.options.now ?? Date.now)() }

  // ------------------------------------------------------------------ renders back
  /** Import MP4s from <project>/renders that were not imported before; each becomes a render asset whose parents are the project's clips. */
  async importRenders(slug: string): Promise<AssetRecord[]> {
    const dir = this.projectDir(slug)
    const rendersDir = join(dir, 'renders')
    let files: string[]
    try { files = (await readdir(rendersDir)).filter(f => /\.(mp4|webm|mov)$/i.test(f)).sort() } catch { return [] }
    const lineagePath = join(dir, 'studio-lineage.json')
    let lineage: { assets: Record<string, string>; imported: string[] } = { assets: {}, imported: [] }
    try { lineage = { ...lineage, ...(JSON.parse(await readFile(lineagePath, 'utf8')) as typeof lineage) } } catch { /* none */ }
    const parents = [...new Set(Object.values(lineage.assets))].map((assetId, ord) => ({ assetId, role: 'video' as const, ord }))
    const out: AssetRecord[] = []
    for (const file of files) {
      const path = join(rendersDir, file)
      const info = await stat(path)
      const key = `${file}:${String(info.size)}:${String(Math.round(info.mtimeMs))}`
      if (lineage.imported.includes(key)) continue
      // A file still being written changes size: wait for it to settle before reading.
      if (this.now() - info.mtimeMs < 2000) continue
      const bytes = new Uint8Array(await readFile(path))
      const asset = await this.core.assets.ingestBytes(bytes, undefined, { source: 'render', title: `${slug}: ${file.replace(/\.[^.]+$/, '')}`, parents, tags: ['render', 'hyperframes'] })
      lineage.imported.push(key); out.push(asset)
    }
    if (out.length > 0) await writeFile(lineagePath, JSON.stringify(lineage, null, 2))
    return out
  }
}

export class HfError extends Error { constructor(readonly status: number, readonly code: string, message?: string) { super(message ?? code) } }

const urlFor = (port: number, slug: string): string => `http://127.0.0.1:${String(port)}/#project/${slug}`
const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))
async function exists(p: string): Promise<boolean> { try { await stat(p); return true } catch { return false } }

/** Ask the OS for a free loopback port. */
export function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => { const port = (server.address() as { port: number }).port; server.close(() => { resolvePort(port) }) })
  })
}
