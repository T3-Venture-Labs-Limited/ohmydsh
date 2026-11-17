/** Plugin configuration (`cordis.patch.yml` -> `config:`). Every field is optional; invalid values fall back to the default. */
export interface PwaConfig {
  /** Application name shown on the install prompt and launcher. */
  readonly name: string
  readonly shortName: string
  /** Where the installed app opens. Default `/app`: a launch from the home screen is cross-site, so the page there signs in first, then goes to the normal DSH UI. `/` is accepted but loses the sign-in on Android. */
  readonly startUrl: string
  /** Manifest colours (a manifest cannot follow the in-app theme; these default to the stock DSH manifest colours). */
  readonly themeColor: string
  readonly backgroundColor: string
  /** Register the service worker. When false `/sw.js` serves a script that unregisters itself and clears its caches. */
  readonly serviceWorker: boolean
  readonly share: ShareConfig
  readonly push: PushConfig
  readonly pairing: PairingConfig
}

export interface PairingConfig {
  /** Phone pairing: one-time codes, device tokens, /pair/* routes. Turning it off removes the routes. */
  readonly enabled: boolean
}

export interface ShareConfig {
  /** Accept Android share-sheet posts at `POST /share`; the shared text lands in a new session's composer as a draft. */
  readonly enabled: boolean
  /** Directory shared files are saved under (`<cwd>/.dsh-shares/<id>/`); empty = next to the share record in the plugin data directory. */
  readonly cwd: string
  /** Cap for one share request (all files together), in MiB. */
  readonly maxMiB: number
}

export interface PushConfig {
  /** Web Push to subscribed devices. Nothing is sent to a device that did not subscribe itself. */
  readonly enabled: boolean
  /** VAPID contact (`mailto:` or `https:`), sent to the push service. */
  readonly subject: string
  /** Accept plain-http push endpoints (tests against a local mock push service only; browsers never produce them). */
  readonly allowInsecureEndpoints: boolean
}

const COLOR = /^#[0-9a-fA-F]{3,8}$/
const PATH = /^\/[A-Za-z0-9_\-./]*$/
const SUBJECT = /^(?:mailto:[^\s@]+@[^\s@]+|https:\/\/[^\s]+)$/

function text(value: unknown, fallback: string, max = 60): string {
  return typeof value === 'string' && value.trim() !== '' ? value.trim().slice(0, max) : fallback
}

/** Normalise raw plugin config. Never throws. */
export function readConfig(raw: unknown): PwaConfig {
  const cfg = (raw !== null && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const section = (key: string): Record<string, unknown> => (cfg[key] !== null && typeof cfg[key] === 'object' ? cfg[key] : {}) as Record<string, unknown>
  const share = section('share')
  const push = section('push')
  const pairing = section('pairing')
  // The phone page at /m no longer exists: a config left over from it falls back to the normal UI.
  const requested = typeof cfg['startUrl'] === 'string' && PATH.test(cfg['startUrl']) ? cfg['startUrl'] : '/app'
  const start = requested === '/m' || requested.startsWith('/m/') ? '/app' : requested
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
      maxMiB,
    },
    pairing: { enabled: pairing['enabled'] !== false },
    push: {
      enabled: push['enabled'] !== false,
      subject: typeof push['subject'] === 'string' && SUBJECT.test(push['subject'].trim()) ? push['subject'].trim() : 'mailto:dsh-pwa@localhost.invalid',
      allowInsecureEndpoints: push['allowInsecureEndpoints'] === true,
    },
  }
}
