// Watches Omarchy's `current/` state directory and publishes the resolved palette.
//
// `omarchy-theme-set` replaces the whole `theme/` directory (rm -rf + mv) and writes `theme.generation` afterwards,
// so we watch the *parent* (`current/`, never `theme/` whose inode is swapped) and treat `theme.generation` as the
// commit marker. Events are debounced; a re-read only publishes when generation/name/mode/colours actually changed.
import { watch, type FSWatcher } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { parseColorsToml, resolvePalette } from '../shared/omarchy.ts'
import type { Colors, Mode } from '../shared/omarchy.ts'

export interface OmarchySnapshot {
  generation: string
  name: string
  mode: Mode
  colors: Colors
}

export function defaultStateDir(env: NodeJS.ProcessEnv = process.env): string {
  const state = env['XDG_STATE_HOME'] !== undefined && env['XDG_STATE_HOME'] !== '' ? env['XDG_STATE_HOME'] : join(homedir(), '.local', 'state')
  return join(state, 'omarchy', 'current')
}

async function text(path: string): Promise<string | undefined> {
  try { return await readFile(path, 'utf8') } catch { return undefined }
}

/** Read the current Omarchy palette; `undefined` when Omarchy is absent or the palette is unusable. */
export async function readOmarchy(dir: string): Promise<OmarchySnapshot | undefined> {
  const toml = await text(join(dir, 'theme', 'colors.toml'))
  if (toml === undefined) return undefined
  let lightFile = false
  try { await stat(join(dir, 'theme', 'light.mode')); lightFile = true } catch { /* dark or declared */ }
  const palette = resolvePalette(parseColorsToml(toml), lightFile)
  if (palette === undefined) return undefined
  const name = (await text(join(dir, 'theme.name')))?.trim() ?? ''
  let generation = (await text(join(dir, 'theme.generation')))?.trim() ?? ''
  if (generation === '') {
    try { const s = await stat(join(dir, 'theme', 'colors.toml')); generation = `m${s.mtimeMs}-${s.size}` } catch { generation = '0' }
  }
  return { generation, name, mode: palette.mode, colors: palette.colors }
}

const sameSnapshot = (a: OmarchySnapshot | undefined, b: OmarchySnapshot | undefined): boolean =>
  a === b || (a !== undefined && b !== undefined && a.generation === b.generation && a.name === b.name && a.mode === b.mode
    && JSON.stringify(a.colors) === JSON.stringify(b.colors))

export interface OmarchyStateOptions {
  dir?: string
  debounceMs?: number
  /** Fallback poll interval when the directory cannot be watched (inotify unavailable or `current/` missing). */
  fallbackPollMs?: number
}

export class OmarchyState {
  private snapshot: OmarchySnapshot | undefined
  private readonly listeners = new Set<(snapshot: OmarchySnapshot | undefined) => void>()
  private watcher: FSWatcher | undefined
  private timer: ReturnType<typeof setTimeout> | undefined
  private poll: ReturnType<typeof setInterval> | undefined
  private stopped = true
  private reading = false
  private again = false
  readonly dir: string
  private readonly debounceMs: number
  private readonly fallbackPollMs: number

  constructor(options: OmarchyStateOptions = {}) {
    this.dir = options.dir ?? defaultStateDir()
    this.debounceMs = options.debounceMs ?? 120
    this.fallbackPollMs = options.fallbackPollMs ?? 2000
  }

  current(): OmarchySnapshot | undefined { return this.snapshot }

  subscribe(listener: (snapshot: OmarchySnapshot | undefined) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** Begin watching. Resolves after the initial read. Returns a disposer. */
  async start(): Promise<() => void> {
    this.stopped = false
    await this.refresh()
    this.attach()
    return () => { this.stop() }
  }

  stop(): void {
    this.stopped = true
    this.watcher?.close()
    this.watcher = undefined
    if (this.timer !== undefined) clearTimeout(this.timer)
    if (this.poll !== undefined) clearInterval(this.poll)
    this.timer = undefined
    this.poll = undefined
    this.listeners.clear()
  }

  private attach(): void {
    if (this.stopped) return
    try {
      const w = watch(this.dir, { persistent: false }, (_event, filename) => {
        const f = filename === null ? '' : String(filename)
        if (f === '' || f === 'theme' || f === 'theme.generation' || f === 'theme.name' || f.startsWith('theme.')) this.schedule()
      })
      w.on('error', () => { this.watcher?.close(); this.watcher = undefined; this.startPoll() })
      this.watcher = w
      if (this.poll !== undefined) { clearInterval(this.poll); this.poll = undefined }
    } catch {
      this.startPoll()
    }
  }

  private startPoll(): void {
    if (this.stopped || this.poll !== undefined) return
    this.poll = setInterval(() => {
      void this.refresh()
      if (this.watcher === undefined) this.attach()
    }, this.fallbackPollMs)
    this.poll.unref?.()
  }

  private schedule(): void {
    if (this.stopped) return
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = setTimeout(() => { this.timer = undefined; void this.refresh() }, this.debounceMs)
    this.timer.unref?.()
  }

  private async refresh(): Promise<void> {
    if (this.reading) { this.again = true; return }
    this.reading = true
    try {
      do {
        this.again = false
        const next = await readOmarchy(this.dir)
        if (!sameSnapshot(this.snapshot, next)) {
          this.snapshot = next
          for (const l of [...this.listeners]) { try { l(next) } catch { /* listener failure must not stop the watcher */ } }
        }
      } while (this.again && !this.stopped)
    } finally { this.reading = false }
  }
}
