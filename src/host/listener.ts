/**
 * Realtime trigger listener: one outbound Pusher socket on `private-cli-<project_id>` (no public URL needed).
 * One listener per $DSH_HOME via a lease file (second DSH process on the same home stays in standby); reconnects by
 * itself (pusher-js) and re-fetches credentials after an auth failure; reports a state the UI shows.
 */
import Pusher from 'pusher-js'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { CHANNEL_PREFIX, ChunkAssembler, decodePusherEvent, privateChannelAuth, type NormalizedEvent } from './events.ts'
import type { ComposioApi } from './api.ts'

export type ListenerState = 'off' | 'standby' | 'connecting' | 'live' | 'error'
export interface ListenerStatus { state: ListenerState; lastEventAt: number | null; lastError: string | null; channel: string | null }

export const LEASE_TTL_MS = 30_000
export const LEASE_RENEW_MS = 10_000

export interface Lease { pid: number; at: number; token: string }

/** Pure lease decision so it can be unit-tested: take it when absent, ours, stale, or its owner pid is gone. */
export function leaseFree(existing: Lease | undefined, token: string, now: number, alive: (pid: number) => boolean): boolean {
  if (existing === undefined) return true
  if (existing.token === token) return true
  if (now - existing.at > LEASE_TTL_MS) return true
  return !alive(existing.pid)
}

const pidAlive = (pid: number): boolean => { try { process.kill(pid, 0); return true } catch { return false } }

export interface ListenerDeps {
  api: Pick<ComposioApi, 'realtimeCredentials' | 'realtimeAuth'>
  leasePath: string
  onEvent: (event: NormalizedEvent) => void
  log: { info(m: string): void; warn(m: string): void }
  now?: () => number
}

export class TriggerListener {
  private pusher: Pusher | undefined
  private status: ListenerStatus = { state: 'off', lastEventAt: null, lastError: null, channel: null }
  private timer: ReturnType<typeof setInterval> | undefined
  private stopped = true
  private readonly token = `${String(process.pid)}-${Math.random().toString(36).slice(2)}`
  private readonly assembler = new ChunkAssembler()
  private retryTimer: ReturnType<typeof setTimeout> | undefined
  private backoff = 2_000

  constructor(private readonly deps: ListenerDeps) {}
  get current(): ListenerStatus { return { ...this.status } }
  private set(patch: Partial<ListenerStatus>): void { this.status = { ...this.status, ...patch } }

  private async readLease(): Promise<Lease | undefined> {
    try { return JSON.parse(await readFile(this.deps.leasePath, 'utf8')) as Lease } catch { return undefined }
  }
  private async writeLease(): Promise<void> {
    await mkdir(dirname(this.deps.leasePath), { recursive: true })
    await writeFile(this.deps.leasePath, JSON.stringify({ pid: process.pid, at: (this.deps.now ?? Date.now)(), token: this.token } satisfies Lease), { mode: 0o600 })
  }

  async start(): Promise<void> {
    this.stopped = false
    await this.tick()
    // Lease renewal / takeover check. Not a data poll: it only touches a local file every 10 s.
    this.timer = setInterval(() => { void this.tick() }, LEASE_RENEW_MS)
    this.timer.unref?.()
  }

  private async tick(): Promise<void> {
    if (this.stopped) return
    const now = (this.deps.now ?? Date.now)()
    const free = leaseFree(await this.readLease(), this.token, now, pidAlive)
    if (!free) { if (this.pusher !== undefined) this.disconnect(); this.set({ state: 'standby' }); return }
    await this.writeLease().catch(() => {})
    if (this.pusher === undefined && this.retryTimer === undefined) await this.connect()
  }

  private async connect(): Promise<void> {
    this.set({ state: 'connecting', lastError: null })
    let creds: Awaited<ReturnType<ComposioApi['realtimeCredentials']>>
    try { creds = await this.deps.api.realtimeCredentials() } catch (error) { this.fail(error instanceof Error ? error.message : String(error)); return }
    if (creds.pusherKey === '' || creds.projectId === '') { this.fail('Composio returned no realtime credentials'); return }
    const channel = `${CHANNEL_PREFIX}${creds.projectId}`
    const pusher = new Pusher(creds.pusherKey, {
      cluster: creds.cluster,
      channelAuthorization: {
        endpoint: '/unused', transport: 'ajax',
        customHandler: ({ socketId, channelName }, callback) => {
          this.deps.api.realtimeAuth(socketId, channelName)
            // Only `{auth}` for a private channel: see events.ts (channel_data breaks the signature).
            .then((response) => { callback(null, privateChannelAuth(response)) })
            .catch((error: unknown) => { callback(error instanceof Error ? error : new Error(String(error)), null) })
        },
      },
    })
    this.pusher = pusher
    pusher.connection.bind('state_change', (change: { current: string }) => {
      if (change.current === 'connecting' || change.current === 'unavailable') this.set({ state: 'connecting' })
    })
    pusher.connection.bind('error', () => { this.set({ lastError: 'connection error' }) })
    const sub = pusher.subscribe(channel)
    sub.bind('pusher:subscription_succeeded', () => { this.backoff = 2_000; this.set({ state: 'live', channel, lastError: null }); this.deps.log.info('composio: listener live') })
    sub.bind('pusher:subscription_error', (e: unknown) => {
      this.deps.log.warn(`composio: subscription error ${JSON.stringify(e).slice(0, 120)}`)
      this.disconnect(); this.fail('subscription rejected (auth)')
    })
    sub.bind_global((eventName: string, data: unknown) => {
      if (eventName.startsWith('pusher')) return
      try {
        const event = decodePusherEvent(this.assembler, eventName, data)
        if (event === undefined) return
        this.set({ lastEventAt: (this.deps.now ?? Date.now)() })
        this.deps.onEvent(event)
      } catch (error) { this.deps.log.warn(`composio: event handling failed: ${String(error)}`) }
    })
  }

  private fail(message: string): void {
    this.set({ state: 'error', lastError: message.slice(0, 200) })
    if (this.stopped || this.retryTimer !== undefined) return
    const wait = this.backoff; this.backoff = Math.min(this.backoff * 2, 60_000)
    this.retryTimer = setTimeout(() => { this.retryTimer = undefined; void this.tick() }, wait)
    this.retryTimer.unref?.()
  }

  private disconnect(): void { try { this.pusher?.disconnect() } catch { /* closed */ } this.pusher = undefined }

  async stop(): Promise<void> {
    this.stopped = true
    if (this.timer !== undefined) clearInterval(this.timer)
    if (this.retryTimer !== undefined) clearTimeout(this.retryTimer)
    this.disconnect()
    this.set({ state: 'off' })
    const lease = await this.readLease()
    if (lease?.token === this.token) await rm(this.deps.leasePath, { force: true }).catch(() => {})
  }
}
