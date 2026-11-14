import webpush from 'web-push'
import type { StoredSubscription, SubscriptionStore } from './subscriptions.ts'
import { redactEndpoint } from './subscriptions.ts'
import type { VapidKeys } from './vapid.ts'

/** What a device receives. Deliberately tiny: no tokens, no URLs, nothing the page could not already show. */
export interface PushPayload {
  readonly v: 1
  readonly kind: 'approval' | 'question' | 'plan' | 'reply' | 'test'
  readonly title: string
  readonly body: string
  /** Session to open on click; empty for the test notification. The service worker also uses it as the notification `tag`. */
  readonly sessionId: string
}

export interface SendSummary {
  readonly sent: number
  readonly removed: number
  readonly failed: number
}

export interface PusherOptions {
  readonly vapid: VapidKeys
  readonly subject: string
  readonly store: SubscriptionStore
  readonly fetch?: typeof fetch
  readonly log?: { warn(...args: unknown[]): void; debug(...args: unknown[]): void }
  readonly timeoutMs?: number
  /** Seconds the push service keeps an undelivered message (a stale "reply finished" is useless after an hour). */
  readonly ttlSeconds?: number
}

const MAX_BODY = 160
const MAX_TITLE = 80

export function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= max ? flat : `${flat.slice(0, Math.max(0, max - 1)).trimEnd()}…`
}

/**
 * Encrypts one payload per subscription (RFC 8291) with `web-push` and posts it with `fetch`, so the request has a
 * timeout and tests can point it at a local mock push service. A 404/410 answer means the subscription is gone for
 * good: it is deleted. Nothing here logs an endpoint or key in full.
 */
export function createPusher(options: PusherOptions) {
  const doFetch = options.fetch ?? globalThis.fetch.bind(globalThis)
  const timeoutMs = options.timeoutMs ?? 15_000
  const vapidDetails = { subject: options.subject, publicKey: options.vapid.publicKey, privateKey: options.vapid.privateKey }

  async function sendOne(subscription: StoredSubscription, payload: PushPayload): Promise<'sent' | 'removed' | 'failed'> {
    const body = JSON.stringify({ ...payload, title: clip(payload.title, MAX_TITLE), body: clip(payload.body, MAX_BODY) })
    try {
      const details = webpush.generateRequestDetails(
        { endpoint: subscription.endpoint, keys: subscription.keys },
        body,
        { vapidDetails, TTL: options.ttlSeconds ?? 3600, urgency: payload.kind === 'reply' || payload.kind === 'test' ? 'normal' : 'high' },
      ) as { endpoint: string; method: string; headers: Record<string, string>; body: Buffer | null }
      const response = await doFetch(details.endpoint, {
        method: details.method,
        headers: details.headers,
        ...(details.body === null ? {} : { body: new Uint8Array(details.body) }),
        signal: AbortSignal.timeout(timeoutMs),
        redirect: 'error',
      })
      await response.arrayBuffer().catch(() => {})
      if (response.status === 404 || response.status === 410) {
        await options.store.remove(subscription.endpoint)
        options.log?.debug('dsh-pwa: push subscription expired and removed', redactEndpoint(subscription.endpoint))
        return 'removed'
      }
      if (!response.ok) {
        options.log?.warn(`dsh-pwa: push service answered ${response.status} for ${redactEndpoint(subscription.endpoint)}`)
        return 'failed'
      }
      return 'sent'
    } catch (error) {
      options.log?.warn(`dsh-pwa: push to ${redactEndpoint(subscription.endpoint)} failed: ${(error as Error).name}`)
      return 'failed'
    }
  }

  return {
    /** Send to one stored subscription. */
    sendTo: (subscription: StoredSubscription, payload: PushPayload): Promise<'sent' | 'removed' | 'failed'> => sendOne(subscription, payload),
    /** Send to every stored subscription. */
    async broadcast(payload: PushPayload): Promise<SendSummary> {
      const subscriptions = await options.store.list()
      const results = await Promise.all(subscriptions.map((s) => sendOne(s, payload)))
      return {
        sent: results.filter((r) => r === 'sent').length,
        removed: results.filter((r) => r === 'removed').length,
        failed: results.filter((r) => r === 'failed').length,
      }
    },
  }
}
export type Pusher = ReturnType<typeof createPusher>
