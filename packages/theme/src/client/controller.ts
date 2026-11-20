// Theme controller: the whole runtime behaviour, free of React and the kit so it stays on the (tiny) boot path.
//
//   choice 'stock'     nothing applied
//   choice 'omarchy'   palette streamed from the Host (Omarchy colors.toml); the default only on the machine running Omarchy
//   choice <palette>   a bundled community palette (data generator, src/artwork/palettes.ts)
//
// Applying = one token layer via ctx.theme.overrideTokens (source 'dsh-theme'), local to this page and never persisted,
// with the palette in BOTH the light and the dark slot. This plugin never calls setTheme: the Appearance preference is one
// value shared by every browser signed in to the Host, so writing it from here would also recolour a phone.
// Everything is undone by one disposer.
//
// dsh-theme-endfield compatibility: when that plugin (square corners, its own accent) is mounted on the page, its token layer
// and its body-scoped `--edge-*` variables would otherwise win over ours. While it is present the layer additionally carries
// its tokens/variables mapped to the palette (src/shared/endfield.ts), is re-registered after endfield re-registers (at most
// MAX_REAPPLY times in a row, so two plugins cannot fight forever), and an ink bridge stylesheet (endfield-dom.ts) keeps text
// on accent fills readable. Corners/geometry are never touched. Without endfield none of this runs.
//
// Endfield look (src/shared/endfield-look.ts + endfield-look-css.ts): the visible parts of dsh-theme-endfield rebuilt cheaply.
// The profile sets the default for every device (`look: endfield` on the dsh-theme row, served at LOOK_URL); a browser
// can override it in Settings > Theme. With colours on Stock the look brings Endfield's own paper/ink palette. While the
// real dsh-theme-endfield plugin is on the page the look stays off (that plugin draws it).
import { isHex } from '../shared/color.ts'
import { PALETTE_KEYS } from '../shared/omarchy.ts'
import type { Colors, Mode, OmarchyPalette } from '../shared/omarchy.ts'
import { paletteTokens, toLayer } from '../shared/tokens.ts'
import { withEndfield } from '../shared/endfield.ts'
import { endfieldOwnLayer, endfieldPalette, isLook, withEndfieldLook } from '../shared/endfield-look.ts'
import type { Look } from '../shared/endfield-look.ts'
import { endfieldLookCss } from './endfield-look-css.ts'
import type { EndfieldFace } from './endfield-dom.ts'
import type { LookFace } from './look-dom.ts'
import type { TokenOptions } from '../shared/tokens.ts'
import { paletteById, PALETTES } from '../artwork/palettes.ts'
import { subscribePush } from '../kit/push/client.ts'

export const SOURCE = 'dsh-theme'
export const SNAPSHOT_URL = '/api/dsh-theme/omarchy'
/** Registry key: one shared live stream per page, however many times the plugin is mounted. */
export const STREAM_ID = 'dsh-theme:omarchy'
/** While the live stream cannot be opened the page re-reads the snapshot at this period (never faster than 15 s). */
export const FALLBACK_POLL_MS = 15_000
/** At most this many re-registrations per REAPPLY_WINDOW_MS to win a token layer back, so two plugins can never ping-pong. */
export const MAX_REAPPLY = 4
export const REAPPLY_WINDOW_MS = 2000
export const LOOK_URL = '/api/dsh-theme/look'
const KEY_CHOICE = 'dsh-theme.choice'
const KEY_SEMANTIC = 'dsh-theme.semantic'
const KEY_LOOK = 'dsh-theme.look'
/** Last profile default seen, so a reload applies the look before the Host answers. */
const KEY_LOOK_DEFAULT = 'dsh-theme.lookDefault'

export type LookChoice = Look | 'default'

export type Choice = string // 'stock' | 'omarchy' | palette id
export type Status = 'idle' | 'connecting' | 'live' | 'unavailable'

export interface OmarchyWire {
  available: boolean
  generation?: string
  name?: string
  mode?: Mode
  colors?: Colors
}

export interface ControllerState {
  choice: Choice
  semanticColors: TokenOptions['semanticColors']
  status: Status
  /** Omarchy theme currently followed (name/mode), when known. */
  omarchy: { name: string; mode: Mode; generation: string; colors: Colors } | undefined
  /** Colour scheme DSH currently renders (Appearance resolved), when known. */
  scheme: Mode | undefined
  /** dsh-theme-endfield is mounted on this page and the compatibility layer is in effect. */
  endfield: boolean
  /** Colours of the palette currently applied, for the preview swatches. */
  applied: { mode: Mode; colors: Colors } | undefined
  /** This browser's look choice; 'default' follows the profile. */
  lookChoice: LookChoice
  /** The profile's default look (dsh-theme row config). */
  lookDefault: Look
  /** The look in effect: lookChoice, or lookDefault when it is 'default'. */
  look: Look
}

/** The slice of ctx.theme used here (matches ThemeRuntime). */
export interface ThemeFace {
  getTheme(): { preference: string; active?: { colorScheme: Mode; tokens?: Readonly<Record<string, string>> } }
  overrideTokens(source: string, tokens: Record<string, { light: string; dark: string }>): () => void
}

export interface ControllerDeps {
  theme: ThemeFace
  /** Host name of the page; Omarchy is followed by default only when it is this computer. Defaults to location.hostname. */
  hostname?: string | undefined
  /** Subscribe to `theme/change`; returns a disposer. */
  onThemeChange(listener: (snapshot: { preference: string; active?: { colorScheme: Mode; tokens?: Readonly<Record<string, string>> } }) => void): () => void
  /** Detects dsh-theme-endfield on the page; omit in tests and on pages without a document. */
  endfield?: EndfieldFace | undefined
  /** Mounts the Endfield look stylesheet; omit in tests and on pages without a document. */
  look?: LookFace | undefined
  storage?: Pick<Storage, 'getItem' | 'setItem'> | undefined
  /** Open the live stream (items are wire snapshots); it must end when the signal aborts. Omit to fall back to snapshot fetches. */
  open?: ((signal: AbortSignal) => AsyncIterable<unknown>) | undefined
  /** Test seam for the shared stream registry host and timers. */
  push?: { host?: object | undefined; setTimeout?: typeof setTimeout; clearTimeout?: typeof clearTimeout } | undefined
  fetchImpl?: typeof fetch | undefined
  /** Document used for visibility/focus re-sync; omit in tests. */
  doc?: Pick<Document, 'addEventListener' | 'removeEventListener' | 'visibilityState'> | undefined
}

export function validWire(wire: unknown): wire is Required<OmarchyWire> & { available: true } {
  if (typeof wire !== 'object' || wire === null) return false
  const w = wire as OmarchyWire
  if (w.available !== true || (w.mode !== 'light' && w.mode !== 'dark') || typeof w.generation !== 'string') return false
  const colors = w.colors as Record<string, unknown> | undefined
  return colors !== undefined && PALETTE_KEYS.every((k) => isHex(colors[k]))
}

export class ThemeController {
  private state: ControllerState
  private readonly listeners = new Set<() => void>()
  private readonly offs: (() => void)[] = []
  private offLayer: (() => void) | undefined
  private unsubscribe: (() => void) | undefined
  private disposed = false
  /** Tokens of the layer we registered (per scheme), to notice another plugin out-ranking them. */
  private ours: Record<string, { light: string; dark: string }> | undefined
  private reapplyTimes: number[] = []

  constructor(private readonly deps: ControllerDeps) {
    const stored = read(deps.storage, KEY_CHOICE)
    const choice = stored !== undefined && (stored === 'stock' || stored === 'omarchy' || paletteById(stored) !== undefined) ? stored : defaultChoice(deps.hostname ?? pageHostname())
    const storedLook = read(deps.storage, KEY_LOOK)
    const lookChoice: LookChoice = isLook(storedLook) ? storedLook : 'default'
    const cachedDefault = read(deps.storage, KEY_LOOK_DEFAULT)
    const lookDefault: Look = isLook(cachedDefault) ? cachedDefault : 'stock'
    this.state = {
      choice,
      semanticColors: read(deps.storage, KEY_SEMANTIC) === 'omarchy' ? 'omarchy' : 'dsh',
      status: 'idle', omarchy: undefined, endfield: false, scheme: deps.theme.getTheme().active?.colorScheme, applied: undefined,
      lookChoice, lookDefault, look: lookChoice === 'default' ? lookDefault : lookChoice,
    }
  }

  /** Bundled palettes, handed to the (lazy) settings page so it never imports the data itself. */
  readonly palettes: readonly { id: string; name: string }[] = PALETTES.map((p) => ({ id: p.id, name: p.name }))

  // ---- store (useSyncExternalStore) ----
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  getSnapshot = (): ControllerState => this.state
  private set(patch: Partial<ControllerState>): void {
    this.state = { ...this.state, ...patch }
    for (const l of [...this.listeners]) l()
  }

  // ---- lifecycle ----
  start(): () => void {
    this.offs.push(this.deps.onThemeChange((s) => { this.onThemeChange(s) }))
    const ef = this.deps.endfield
    if (ef !== undefined) {
      this.set({ endfield: ef.present() })
      this.offs.push(ef.subscribe(() => {
        const present = ef.present()
        if (present !== this.state.endfield) this.set({ endfield: present })
        this.sync()
      }))
    }
    const doc = this.deps.doc
    if (doc !== undefined) {
      const resync = (): void => { if (doc.visibilityState !== 'hidden') { void this.refetch(); void this.fetchLookDefault() } }
      doc.addEventListener('visibilitychange', resync)
      this.offs.push(() => { doc.removeEventListener('visibilitychange', resync) })
    }
    this.connect()
    this.sync()
    void this.fetchLookDefault()
    return () => { this.dispose() }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.closeStream()
    this.disengage()
    for (const off of this.offs.splice(0)) off()
    this.listeners.clear()
  }

  // ---- user intents ----
  setChoice(choice: Choice): void {
    if (choice !== 'stock' && choice !== 'omarchy' && paletteById(choice) === undefined) return
    write(this.deps.storage, KEY_CHOICE, choice)
    this.set({ choice })
    this.connect()
    this.sync()
  }

  setSemanticColors(value: TokenOptions['semanticColors']): void {
    write(this.deps.storage, KEY_SEMANTIC, value)
    this.set({ semanticColors: value })
    this.sync()
  }

  /** This browser's look: 'default' follows the profile, 'stock' / 'endfield' override it here only. */
  setLook(choice: LookChoice): void {
    if (choice !== 'default' && !isLook(choice)) return
    write(this.deps.storage, KEY_LOOK, choice)
    this.set({ lookChoice: choice, look: choice === 'default' ? this.state.lookDefault : choice })
    this.sync()
  }

  // ---- internals ----
  private sync(): void {
    if (this.disposed) return
    const palette = this.resolve()
    if (palette === undefined) { this.disengage(); this.set({ applied: undefined }); return }
    this.engage(palette)
  }

  /** Open or close the Host stream to match the current choice. Never called from sync(), so a failed fetch cannot loop. */
  private connect(): void {
    if (this.state.choice === 'omarchy') this.openStream()
    else this.closeStream()
  }

  private resolve(): OmarchyPalette | undefined {
    const { choice, omarchy } = this.state
    if (choice === 'stock') return this.lookOn() ? endfieldPalette(this.state.scheme ?? 'dark') : undefined
    if (choice === 'omarchy') return omarchy === undefined ? undefined : { mode: omarchy.mode, colors: omarchy.colors }
    const p = paletteById(choice)
    return p === undefined ? undefined : { mode: p.mode, colors: p.colors }
  }

  private engage(palette: OmarchyPalette): void {
    this.offLayer?.()
    const options = { semanticColors: this.state.semanticColors }
    const lookOn = this.lookOn()
    // Colours on Stock reach here only with the look on: Endfield's own measured tokens, not our palette maths.
    const own = lookOn && this.state.choice === 'stock'
    const base = own ? {} : toLayer(paletteTokens(palette, options))
    const layer = own ? endfieldOwnLayer(palette.mode) : this.state.endfield ? withEndfield(base, palette, options) : lookOn ? withEndfieldLook(base, palette, options) : base
    this.deps.endfield?.bridge(this.state.endfield)
    this.deps.look?.apply(lookOn ? endfieldLookCss(palette.mode) : undefined)
    this.ours = layer
    this.offLayer = this.deps.theme.overrideTokens(SOURCE, layer)
    this.set({ applied: palette, scheme: this.deps.theme.getTheme().active?.colorScheme ?? this.state.scheme })
  }

  /** Remove the layer. The Appearance preference was never touched, so there is nothing else to restore. */
  private disengage(): void {
    this.offLayer?.()
    this.offLayer = undefined
    this.ours = undefined
    this.deps.endfield?.bridge(false)
    this.deps.look?.apply(undefined)
  }

  /** The look is drawn here unless the real dsh-theme-endfield plugin is on the page. */
  private lookOn(): boolean {
    return this.state.look === 'endfield' && !this.state.endfield
  }

  /** Read the profile's default look. A failed read keeps the cached value (the look never flickers off offline). */
  private async fetchLookDefault(): Promise<void> {
    if (this.disposed) return
    const f = this.deps.fetchImpl ?? (typeof fetch === 'undefined' ? undefined : fetch.bind(globalThis))
    if (f === undefined) return
    let next: unknown
    try {
      const response = await f(LOOK_URL, { credentials: 'same-origin', cache: 'no-store' })
      if (!response.ok) return
      next = (parse(await response.text()) as { look?: unknown } | undefined)?.look
    } catch { return }
    if (this.disposed || !isLook(next) || next === this.state.lookDefault) return
    write(this.deps.storage, KEY_LOOK_DEFAULT, next)
    this.set({ lookDefault: next, look: this.state.lookChoice === 'default' ? next : this.state.lookChoice })
    this.sync()
  }

  /** Track the rendered colour scheme (for the "does not match your Omarchy theme" hint) and, with endfield present, win tokens back. */
  private onThemeChange(snapshot: { active?: { colorScheme: Mode; tokens?: Readonly<Record<string, string>> } }): void {
    const scheme = snapshot.active?.colorScheme
    if (scheme !== undefined && scheme !== this.state.scheme) {
      this.set({ scheme })
      // Stock colours + Endfield look: the palette is Endfield's own light or dark one, so it follows Appearance.
      if (this.state.choice === 'stock' && this.lookOn()) { this.sync(); return }
    }
    if (!this.state.endfield || this.ours === undefined || this.disposed || scheme === undefined) return
    const tokens = snapshot.active?.tokens
    if (tokens === undefined) return
    const lost = Object.entries(this.ours).some(([name, modes]) => tokens[name] !== modes[scheme])
    if (!lost) return
    // Another layer registered after ours and overrides some of our tokens: register again on top. Re-registering emits
    // theme/change, so it is rate-limited: a peer that re-registers on every change cannot start a loop.
    const now = Date.now()
    this.reapplyTimes = this.reapplyTimes.filter((at) => now - at < REAPPLY_WINDOW_MS)
    if (this.reapplyTimes.length >= MAX_REAPPLY) return
    this.reapplyTimes.push(now)
    this.sync()
  }

  /**
   * Follow the shared live stream. It is open only while this page is visible; hidden, it is closed (no connection held)
   * and the visibilitychange handler re-reads the snapshot when the page comes back. While the stream cannot be opened a
   * slow snapshot poll keeps the palette fresh.
   */
  private openStream(): void {
    if (this.unsubscribe !== undefined || this.disposed) return
    const open = this.deps.open
    if (open === undefined) { void this.refetch(); return }
    this.set({ status: 'connecting' })
    this.unsubscribe = subscribePush<unknown>({
      id: STREAM_ID,
      open,
      poll: () => this.refetch(),
      pollMs: FALLBACK_POLL_MS,
    }, (wire) => { this.receive(wire) }, { doc: this.deps.doc as Document | undefined, ...this.deps.push })
  }

  private closeStream(): void {
    this.unsubscribe?.()
    this.unsubscribe = undefined
    if (this.state.status !== 'idle') this.set({ status: 'idle' })
  }

  private async refetch(): Promise<void> {
    if (this.state.choice !== 'omarchy' || this.disposed) return
    const f = this.deps.fetchImpl ?? (typeof fetch === 'undefined' ? undefined : fetch.bind(globalThis))
    if (f === undefined) return
    try {
      const response = await f(SNAPSHOT_URL, { credentials: 'same-origin', cache: 'no-store' })
      if (!response.ok) { this.receive(undefined); return }
      this.receive(parse(await response.text()))
    } catch { this.receive(undefined) }
  }

  private receive(wire: unknown): void {
    if (this.disposed || this.state.choice !== 'omarchy') return
    if (!validWire(wire)) {
      this.set({ omarchy: undefined, status: 'unavailable' })
      this.sync()
      return
    }
    const prev = this.state.omarchy
    if (prev !== undefined && prev.generation === wire.generation && this.state.status === 'live') return
    this.set({ omarchy: { name: wire.name, mode: wire.mode, generation: wire.generation, colors: wire.colors }, status: 'live' })
    this.sync()
  }
}

/** Omarchy runs on this computer only: follow it by default when the page is served from a loopback address. */
export function isLoopbackHost(hostname: string | undefined): boolean {
  if (hostname === undefined) return false
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  return h === 'localhost' || h === '::1' || /^127(\.\d{1,3}){3}$/.test(h)
}
export function defaultChoice(hostname: string | undefined): Choice {
  return isLoopbackHost(hostname) ? 'omarchy' : 'stock'
}
function pageHostname(): string | undefined {
  return (globalThis as { location?: { hostname?: string } }).location?.hostname
}

function parse(text: string): unknown {
  try { return JSON.parse(text) } catch { return undefined }
}
function read(storage: ControllerDeps['storage'], key: string): string | undefined {
  try { return storage?.getItem(key) ?? undefined } catch { return undefined }
}
function write(storage: ControllerDeps['storage'], key: string, value: string): void {
  try { storage?.setItem(key, value) } catch { /* private mode: choice lasts for this page only */ }
}

