/** Plugin configuration (`cordis.patch.yml` -> `config:`). Every field is optional; invalid values fall back to the default. */
export interface PwaConfig {
  /** Application name shown on the install prompt and launcher. */
  readonly name: string
  readonly shortName: string
  /** Where the installed app opens. `/m` is the light phone view, `/` the full DSH UI. */
  readonly startUrl: string
  /** Manifest colours (the theme tokens cannot be read from a manifest; these default to the DSH launch colours). */
  readonly themeColor: string
  readonly backgroundColor: string
  /** Register the service worker. When false `/sw.js` serves a script that unregisters itself and clears its caches. */
  readonly serviceWorker: boolean
  readonly share: ShareConfig
}

export interface ShareConfig {
  /** Accept Android share-sheet posts at `POST /share`. */
  readonly enabled: boolean
  /** Workspace directory the shared text and files land in; empty = the most recently active session's directory. */
  readonly cwd: string
  /** `draft`: create an empty session and pre-fill the /m composer. `session`: also send the shared content as the first prompt (starts an agent turn). */
  readonly mode: 'draft' | 'session'
  /** Cap for one share request (all files together), in MiB. */
  readonly maxMiB: number
}

const COLOR = /^#[0-9a-fA-F]{3,8}$/
const PATH = /^\/[A-Za-z0-9_\-./]*$/

function text(value: unknown, fallback: string, max = 60): string {
  return typeof value === 'string' && value.trim() !== '' ? value.trim().slice(0, max) : fallback
}

/** Normalise raw plugin config. Never throws. */
export function readConfig(raw: unknown): PwaConfig {
  const cfg = (raw !== null && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const share = (cfg['share'] !== null && typeof cfg['share'] === 'object' ? cfg['share'] : {}) as Record<string, unknown>
  const start = typeof cfg['startUrl'] === 'string' && PATH.test(cfg['startUrl']) ? cfg['startUrl'] : '/m'
  const maxMiB = typeof share['maxMiB'] === 'number' && Number.isFinite(share['maxMiB']) ? Math.min(Math.max(share['maxMiB'], 1), 200) : 25
  return {
    name: text(cfg['name'], 'DeepSeek Harness'),
    shortName: text(cfg['shortName'], 'DSH', 12),
    startUrl: start,
    themeColor: typeof cfg['themeColor'] === 'string' && COLOR.test(cfg['themeColor']) ? cfg['themeColor'] : '#ffffff', // artwork:ok
    backgroundColor: typeof cfg['backgroundColor'] === 'string' && COLOR.test(cfg['backgroundColor']) ? cfg['backgroundColor'] : '#ffffff', // artwork:ok
    serviceWorker: cfg['serviceWorker'] !== false,
    share: {
      enabled: share['enabled'] !== false,
      cwd: typeof share['cwd'] === 'string' ? share['cwd'].trim() : '',
      mode: share['mode'] === 'session' ? 'session' : 'draft',
      maxMiB,
    },
  }
}
