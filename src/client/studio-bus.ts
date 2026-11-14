// Cross-surface intents ("open in composer", "open in HyperFrames", "show asset") shared between the boot bundle
// (slots, tool cards' openers) and the lazy workbench chunk. Lives on globalThis because chunks are self-contained.
import { sharedState } from './shared-state.js'

export type StudioTab = 'create' | 'gallery' | 'styles' | 'video'

export interface ComposerPrefill {
  op?: 'generate' | 'edit' | 'upscale' | 'animate' | 'restyle' | 'extend'
  kind?: 'image' | 'video'
  modelId?: string
  prompt?: string
  negativePrompt?: string
  params?: Record<string, string | number | boolean>
  /** Asset ids to place in tray slots. */
  source?: string
  references?: string[]
  firstFrame?: string
  lastFrame?: string
  video?: string
}

export type StudioIntent =
  | { tab: 'create'; prefill?: ComposerPrefill }
  | { tab: 'gallery'; assetId?: string }
  | { tab: 'styles' }
  | { tab: 'video'; assetIds?: string[] }

interface Bus {
  pending: StudioIntent | undefined
  listeners: Set<(intent: StudioIntent) => void>
  /** Registered by the boot bundle: reveals the Studio surface (the right-sidebar tab). */
  opener: ((intent: StudioIntent) => void) | undefined
}

const bus = (): Bus => sharedState<Bus>('studioBus', () => ({ pending: undefined, listeners: new Set(), opener: undefined }))

export const studioBus = {
  /** Ask Studio to do something; reveals the surface when nothing is mounted. */
  emit(intent: StudioIntent): void {
    const b = bus()
    if (b.listeners.size === 0) { b.pending = intent; b.opener?.(intent); return }
    b.opener?.(intent)
    for (const listener of b.listeners) listener(intent)
  },
  /** A mounted workbench consumes intents; a pending one (emitted before mount) is delivered on subscribe. */
  subscribe(listener: (intent: StudioIntent) => void): () => void {
    const b = bus()
    b.listeners.add(listener)
    if (b.pending !== undefined) { const intent = b.pending; b.pending = undefined; queueMicrotask(() => { listener(intent) }) }
    return () => { b.listeners.delete(listener) }
  },
  setOpener(opener: ((intent: StudioIntent) => void) | undefined): void { bus().opener = opener },
}
