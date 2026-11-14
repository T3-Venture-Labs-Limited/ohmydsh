import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/** A browser PushSubscription as stored: the endpoint is the key. */
export interface StoredSubscription {
  readonly endpoint: string
  readonly keys: { readonly p256dh: string; readonly auth: string }
  readonly label: string
  readonly createdAt: number
}

const B64URL = /^[A-Za-z0-9_-]{8,200}$/

export class SubscriptionError extends Error {}

/** Validate an untrusted `PushSubscription.toJSON()` body. Throws {@link SubscriptionError}. */
export function parseSubscription(raw: unknown, options: { allowInsecure: boolean }): { endpoint: string; keys: { p256dh: string; auth: string } } {
  if (raw === null || typeof raw !== 'object') throw new SubscriptionError('subscription must be an object')
  const { endpoint, keys } = raw as { endpoint?: unknown; keys?: unknown }
  if (typeof endpoint !== 'string' || endpoint.length === 0 || endpoint.length > 2048) throw new SubscriptionError('invalid endpoint')
  let url: URL
  try { url = new URL(endpoint) } catch { throw new SubscriptionError('invalid endpoint') }
  if (url.username !== '' || url.password !== '') throw new SubscriptionError('invalid endpoint')
  if (url.protocol !== 'https:' && !(options.allowInsecure && url.protocol === 'http:')) throw new SubscriptionError('endpoint must be https')
  if (!options.allowInsecure && isPrivateHost(url.hostname)) throw new SubscriptionError('endpoint host is not a public push service')
  if (keys === null || typeof keys !== 'object') throw new SubscriptionError('missing keys')
  const { p256dh, auth } = keys as { p256dh?: unknown; auth?: unknown }
  if (typeof p256dh !== 'string' || typeof auth !== 'string' || !B64URL.test(p256dh) || !B64URL.test(auth)) throw new SubscriptionError('invalid keys')
  return { endpoint: url.toString(), keys: { p256dh, auth } }
}

/** The host will POST to this URL, so literal loopback / private / link-local addresses and `localhost` are refused. */
export function isPrivateHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return true
  const v4 = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(host)
  if (v4 !== null) {
    const [a, b] = [Number(v4[1]), Number(v4[2])]
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127)
  }
  if (host.includes(':')) return host === '::1' || host === '::' || host.startsWith('fe80') || host.startsWith('fc') || host.startsWith('fd') || host.startsWith('::ffff:')
  return false
}

/** Log-safe form of an endpoint: the push service host and the last few characters, never the whole URL. */
export function redactEndpoint(endpoint: string): string {
  try {
    const url = new URL(endpoint)
    return `${url.host}/…${endpoint.slice(-6)}`
  } catch {
    return '(invalid endpoint)'
  }
}

/**
 * Subscriptions keyed by endpoint, kept in one JSON file (0600). Writes are serialised and atomic (temp file + rename),
 * so a crash cannot leave a half-written file.
 */
export class SubscriptionStore {
  private cache: Map<string, StoredSubscription> | undefined
  private queue: Promise<unknown> = Promise.resolve()

  constructor(private readonly file: string) {}

  private async load(): Promise<Map<string, StoredSubscription>> {
    if (this.cache !== undefined) return this.cache
    const map = new Map<string, StoredSubscription>()
    try {
      const parsed: unknown = JSON.parse(await readFile(this.file, 'utf8'))
      const items = (parsed as { subscriptions?: unknown })?.subscriptions
      if (Array.isArray(items)) {
        for (const item of items as StoredSubscription[]) {
          if (typeof item?.endpoint === 'string' && typeof item.keys?.p256dh === 'string' && typeof item.keys.auth === 'string') {
            map.set(item.endpoint, { endpoint: item.endpoint, keys: { p256dh: item.keys.p256dh, auth: item.keys.auth }, label: String(item.label ?? ''), createdAt: Number(item.createdAt) || 0 })
          }
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    this.cache = map
    return map
  }

  private async save(map: Map<string, StoredSubscription>): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true, mode: 0o700 })
    const tmp = `${this.file}.${process.pid}.tmp`
    await writeFile(tmp, JSON.stringify({ subscriptions: [...map.values()] }), { mode: 0o600 })
    await rename(tmp, this.file)
    await chmod(this.file, 0o600).catch(() => {})
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn)
    this.queue = run.catch(() => {})
    return run
  }

  list(): Promise<StoredSubscription[]> {
    return this.serial(async () => [...(await this.load()).values()])
  }

  get(endpoint: string): Promise<StoredSubscription | undefined> {
    return this.serial(async () => (await this.load()).get(endpoint))
  }

  /** Insert or refresh a subscription; a known endpoint keeps its original creation time. */
  upsert(subscription: { endpoint: string; keys: { p256dh: string; auth: string } }, label: string, now = Date.now()): Promise<StoredSubscription> {
    return this.serial(async () => {
      const map = await this.load()
      const stored: StoredSubscription = { endpoint: subscription.endpoint, keys: subscription.keys, label, createdAt: map.get(subscription.endpoint)?.createdAt ?? now }
      map.set(stored.endpoint, stored)
      await this.save(map)
      return stored
    })
  }

  remove(endpoint: string): Promise<boolean> {
    return this.serial(async () => {
      const map = await this.load()
      const had = map.delete(endpoint)
      if (had) await this.save(map)
      return had
    })
  }
}
