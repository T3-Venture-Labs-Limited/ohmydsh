// Phone pairing: one-time codes (in memory, 10 minutes, single use), long-lived device tokens (stored hashed),
// and the failure rate limiter. Pure logic with injectable clock/random so every rule is unit-tested.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export const CODE_TTL_MS = 10 * 60 * 1000
export const MAX_OUTSTANDING_CODES = 3
export const MAX_DEVICES = 20
const LAST_SEEN_WRITE_MS = 60 * 1000
export const DEVICE_TOKEN_PREFIX = 'dsh-dev_'

export class PairingError extends Error {
  constructor(message: string, readonly status: number = 400) { super(message) }
}

const sha256 = (value: string): Buffer => createHash('sha256').update(value, 'utf8').digest()

/** Constant-time equality of two secrets of any length (both are hashed first, so the length never leaks). */
export function secretsEqual(a: string, b: string): boolean {
  return timingSafeEqual(sha256(a), sha256(b))
}

/** A device name that is safe to show and store: printable characters only, trimmed, at most 60. */
export function cleanDeviceName(value: unknown): string {
  const text = typeof value === 'string' ? value.replace(/[\p{Cc}\p{Cf}<>]/gu, '').replace(/\s+/g, ' ').trim() : ''
  return text === '' ? 'Phone' : text.slice(0, 60)
}

// ── Rate limiter ──────────────────────────────────────────────────────────────────────────────

/** Sliding window of failures per key plus one global window. A blocked key is refused even with the right secret. */
export class FailureLimiter {
  private readonly perKey = new Map<string, number[]>()
  private global: number[] = []
  constructor(
    private readonly perKeyMax: number,
    private readonly globalMax: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  private prune(list: number[], at: number): number[] {
    const from = at - this.windowMs
    let i = 0
    while (i < list.length && list[i]! <= from) i += 1
    return i === 0 ? list : list.slice(i)
  }

  /** Seconds until a request from `key` may try again, or 0 when it may. */
  retryAfter(key: string): number {
    const at = this.now()
    this.global = this.prune(this.global, at)
    const mine = this.prune(this.perKey.get(key) ?? [], at)
    if (mine.length === 0) this.perKey.delete(key); else this.perKey.set(key, mine)
    const wait = (list: number[], max: number): number => (list.length >= max ? Math.max(1, Math.ceil((list[list.length - max]! + this.windowMs - at) / 1000)) : 0)
    return Math.max(wait(mine, this.perKeyMax), wait(this.global, this.globalMax))
  }

  fail(key: string): void {
    const at = this.now()
    const mine = this.prune(this.perKey.get(key) ?? [], at)
    mine.push(at)
    this.perKey.set(key, mine)
    this.global.push(at)
    if (this.perKey.size > 1000) for (const k of [...this.perKey.keys()].slice(0, 500)) this.perKey.delete(k)
  }
}

// ── Devices ───────────────────────────────────────────────────────────────────────────────────

export interface StoredDevice {
  readonly id: string
  readonly name: string
  /** sha256 (hex) of the device token. The token itself is never stored. */
  readonly tokenHash: string
  readonly createdAt: number
  lastSeen: number
}

export interface PublicDevice { id: string; name: string; createdAt: number; lastSeen: number }

const publicDevice = (d: StoredDevice): PublicDevice => ({ id: d.id, name: d.name, createdAt: d.createdAt, lastSeen: d.lastSeen })

interface SessionRecord { readonly device: string; readonly hash: string; readonly at: number }
interface RevokedRecord { readonly hash: string; readonly until: number }

/** Core's sign-in cookie lives at most 30 days (cookieMaxAgeDays default; it can be raised, so keep records a little longer). */
const SESSION_KEEP_MS = 45 * 24 * 3600 * 1000
const MAX_SESSIONS = 400
const HEX64 = /^[a-f0-9]{64}$/

/** `name=value; Attr...` (a Set-Cookie line) -> value of a `dsh-auth-*` cookie, else undefined. */
export function authCookieValue(setCookie: string): string | undefined {
  const first = setCookie.split(';')[0] ?? ''
  const at = first.indexOf('=')
  return at > 0 && first.slice(0, at).trim().startsWith('dsh-auth-') ? first.slice(at + 1).trim() : undefined
}

export const cookieHash = (value: string): string => sha256(value).toString('hex')

export class DeviceStore {
  private devices: Map<string, StoredDevice> | undefined
  private sessions: SessionRecord[] = []
  private revoked: RevokedRecord[] = []
  private revokedSet = new Set<string>()
  private queue: Promise<unknown> = Promise.resolve()
  constructor(private readonly file: string, private readonly now: () => number = Date.now) {}

  private async load(): Promise<Map<string, StoredDevice>> {
    if (this.devices !== undefined) return this.devices
    const map = new Map<string, StoredDevice>()
    try {
      const parsed = JSON.parse(await readFile(this.file, 'utf8')) as { devices?: unknown; sessions?: unknown; revoked?: unknown }
      if (Array.isArray(parsed.devices)) {
        for (const d of parsed.devices as StoredDevice[]) {
          if (typeof d?.id === 'string' && typeof d.tokenHash === 'string' && HEX64.test(d.tokenHash)) {
            map.set(d.id, { id: d.id, name: cleanDeviceName(d.name), tokenHash: d.tokenHash, createdAt: Number(d.createdAt) || 0, lastSeen: Number(d.lastSeen) || 0 })
          }
        }
      }
      if (Array.isArray(parsed.sessions)) this.sessions = (parsed.sessions as SessionRecord[]).filter((r) => typeof r?.device === 'string' && HEX64.test(String(r.hash)) && Number(r.at) > 0)
      if (Array.isArray(parsed.revoked)) this.revoked = (parsed.revoked as RevokedRecord[]).filter((r) => HEX64.test(String(r?.hash)) && Number(r.until) > 0)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    this.devices = map
    this.pruneRecords()
    return map
  }

  private pruneRecords(): void {
    const at = this.now()
    this.sessions = this.sessions.filter((r) => at - r.at < SESSION_KEEP_MS).slice(-MAX_SESSIONS)
    this.revoked = this.revoked.filter((r) => r.until > at)
    this.revokedSet = new Set(this.revoked.map((r) => r.hash))
  }

  private async save(): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true, mode: 0o700 })
    const tmp = `${this.file}.${process.pid}.tmp`
    await writeFile(tmp, JSON.stringify({ devices: [...(this.devices?.values() ?? [])], sessions: this.sessions, revoked: this.revoked }), { mode: 0o600 })
    await rename(tmp, this.file)
    await chmod(this.file, 0o600).catch(() => {})
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn)
    this.queue = run.catch(() => {})
    return run
  }

  /** Read the file now (call once at start so the synchronous checks below are live). */
  warm(): Promise<void> {
    return this.serial(async () => { await this.load() })
  }

  list(): Promise<PublicDevice[]> {
    return this.serial(async () => [...(await this.load()).values()].map(publicDevice).sort((a, b) => b.createdAt - a.createdAt))
  }

  /**
   * Synchronous, for hot paths: true when any `dsh-auth-*` cookie in this Cookie header was minted for a device that has since
   * been removed. Only ever used to refuse.
   */
  isRevokedCookie(cookieHeader: unknown): boolean {
    if (typeof cookieHeader !== 'string' || this.revokedSet.size === 0) return false
    for (const part of cookieHeader.split(';')) {
      const at = part.indexOf('=')
      if (at > 0 && part.slice(0, at).trim().startsWith('dsh-auth-') && this.revokedSet.has(cookieHash(part.slice(at + 1).trim()))) return true
    }
    return false
  }

  /** Remember that `device` was given this sign-in cookie, so removing the device can invalidate exactly these cookies. */
  recordSession(deviceId: string, setCookieLines: readonly string[]): Promise<void> {
    return this.serial(async () => {
      await this.load()
      const at = this.now()
      for (const line of setCookieLines) {
        const value = authCookieValue(line)
        if (value !== undefined) this.sessions.push({ device: deviceId, hash: cookieHash(value), at })
      }
      this.pruneRecords()
      await this.save()
    })
  }

  /** Create a device and return its token (shown to the device once; only the hash is kept). */
  add(name: string): Promise<{ device: PublicDevice; token: string }> {
    return this.serial(async () => {
      const map = await this.load()
      if (map.size >= MAX_DEVICES) throw new PairingError(`too many paired devices (max ${MAX_DEVICES}); remove one first`, 409)
      const token = DEVICE_TOKEN_PREFIX + randomBytes(32).toString('base64url')
      const at = this.now()
      const device: StoredDevice = { id: randomBytes(12).toString('hex'), name: cleanDeviceName(name), tokenHash: sha256(token).toString('hex'), createdAt: at, lastSeen: at }
      map.set(device.id, device)
      await this.save()
      return { device: publicDevice(device), token }
    })
  }

  /** The device owning `token`, or undefined. Compares against every stored hash in constant time per entry. */
  authenticate(token: string): Promise<PublicDevice | undefined> {
    return this.serial(async () => {
      if (!token.startsWith(DEVICE_TOKEN_PREFIX) || token.length > 200) return undefined
      const map = await this.load()
      const wanted = sha256(token)
      let found: StoredDevice | undefined
      for (const d of map.values()) if (timingSafeEqual(wanted, Buffer.from(d.tokenHash, 'hex')) && found === undefined) found = d
      if (found === undefined) return undefined
      const at = this.now()
      if (at - found.lastSeen > LAST_SEEN_WRITE_MS) { found.lastSeen = at; await this.save() }
      return publicDevice(found)
    })
  }

  /** Revoke now: the token stops working and every sign-in cookie minted for this device is refused from the next request on. */
  remove(id: string): Promise<boolean> {
    return this.serial(async () => {
      const map = await this.load()
      const had = map.delete(id)
      if (!had) return false
      const until = this.now() + SESSION_KEEP_MS
      for (const r of this.sessions) if (r.device === id) this.revoked.push({ hash: r.hash, until })
      this.sessions = this.sessions.filter((r) => r.device !== id)
      this.pruneRecords()
      await this.save()
      return true
    })
  }
}

// ── One-time codes ────────────────────────────────────────────────────────────────────────────

export interface IssuedCode { code: string; expiresAt: number }

export class CodeBook {
  private readonly codes = new Map<string, number>() // sha256(code) hex -> expiresAt
  constructor(private readonly now: () => number = Date.now, private readonly ttlMs: number = CODE_TTL_MS) {}

  private sweep(): void {
    const at = this.now()
    for (const [hash, expires] of this.codes) if (expires <= at) this.codes.delete(hash)
  }

  issue(): IssuedCode {
    this.sweep()
    while (this.codes.size >= MAX_OUTSTANDING_CODES) this.codes.delete(this.codes.keys().next().value as string)
    const code = randomBytes(16).toString('base64url')
    const expiresAt = this.now() + this.ttlMs
    this.codes.set(sha256(code).toString('hex'), expiresAt)
    return { code, expiresAt }
  }

  /**
   * Consume `code`. True exactly once for a live code. Every stored code is compared in constant time, and a match is deleted
   * before returning, so two concurrent claims cannot both win.
   */
  consume(code: string): boolean {
    this.sweep()
    if (code.length < 16 || code.length > 64) return false
    const wanted = sha256(code)
    let matched: string | undefined
    for (const hash of this.codes.keys()) if (timingSafeEqual(wanted, Buffer.from(hash, 'hex')) && matched === undefined) matched = hash
    if (matched === undefined) return false
    this.codes.delete(matched)
    return true
  }

  outstanding(): number { this.sweep(); return this.codes.size }
  clear(): void { this.codes.clear() }
}

/** `Authorization: Bearer <device token>` -> the token, else undefined. */
export function bearerToken(header: unknown): string | undefined {
  if (typeof header !== 'string') return undefined
  const m = /^Bearer\s+(\S{8,200})$/i.exec(header.trim())
  return m?.[1]
}
