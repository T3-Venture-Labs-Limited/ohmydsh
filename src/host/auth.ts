/**
 * Webhook authentication on the RAW body bytes. Every comparison is constant time.
 *  - token:              `Authorization: Bearer <secret>` or `X-Trigger-Token: <secret>`
 *  - hmac-sha256:        `X-Hub-Signature-256: sha256=<hex hmac(secret, body)>` (GitHub; key = the secret string)
 *  - standard-webhooks:  svix spec: `webhook-id`, `webhook-timestamp`, `webhook-signature: v1,<b64> [v1,<b64> …]`,
 *                        signed content `${id}.${timestamp}.${body}`, key = base64-decode(secret minus `whsec_`), ±5 min
 *  - none:               loopback peer only, and no proxy header (tailscale serve proxies from loopback)
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import type { WebhookAuth } from '../shared/types.ts'
import { header } from './util.ts'

export const TIMESTAMP_TOLERANCE_SEC = 5 * 60
type Headers = Record<string, string | string[] | undefined>

export const generateSecret = (): string => `whsec_${randomBytes(32).toString('base64')}`
export const secretHint = (secret: string | undefined): string | null => (secret === undefined ? null : `${secret.slice(0, 8)}…${secret.slice(-2)}`)

export function safeEqual(a: string | Buffer, b: string | Buffer): boolean {
  const x = typeof a === 'string' ? Buffer.from(a) : a
  const y = typeof b === 'string' ? Buffer.from(b) : b
  if (x.length !== y.length) { timingSafeEqual(x, x); return false }
  return timingSafeEqual(x, y)
}

export function isLoopbackAddress(address: string | undefined): boolean {
  if (address === undefined) return false
  const a = address.toLowerCase().replace(/%.*$/, '')
  return a === '::1' || a.startsWith('127.') || a.startsWith('::ffff:127.') || a === '0:0:0:0:0:0:0:1'
}

const PROXY_HEADERS = ['x-forwarded-for', 'forwarded', 'x-real-ip', 'x-forwarded-host', 'tailscale-user-login']
/** Headers only browsers send: a web page on this machine must not be able to fire an unauthenticated hook. */
const BROWSER_HEADERS = ['origin', 'sec-fetch-site']

/** A direct loopback request: loopback peer, no proxy header, not from a browser page. */
export function isDirectLoopback(remoteAddress: string | undefined, headers: Headers): boolean {
  return isLoopbackAddress(remoteAddress) && [...PROXY_HEADERS, ...BROWSER_HEADERS].every((h) => headers[h] === undefined)
}

export function standardWebhooksKey(secret: string): Buffer {
  return Buffer.from(secret.startsWith('whsec_') ? secret.slice('whsec_'.length) : secret, 'base64')
}

export function signStandardWebhook(secret: string, id: string, timestamp: string, body: Buffer | string): string {
  const mac = createHmac('sha256', standardWebhooksKey(secret)).update(`${id}.${timestamp}.`).update(body).digest('base64')
  return `v1,${mac}`
}
export const signHubSha256 = (secret: string, body: Buffer | string): string => `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`

export type AuthResult = { ok: true } | { ok: false; reason: string }

export interface AuthInput { auth: WebhookAuth; secret: string | undefined; headers: Headers; body: Buffer; remoteAddress: string | undefined; now: number }

export function verifyWebhook(input: AuthInput): AuthResult {
  const { auth, secret, headers, body } = input
  if (auth === 'none') return isDirectLoopback(input.remoteAddress, headers) ? { ok: true } : { ok: false, reason: 'not-loopback' }
  if (secret === undefined || secret === '') return { ok: false, reason: 'no-secret' }
  switch (auth) {
    case 'token': {
      const bearer = header(headers, 'authorization')
      const m = bearer === undefined ? undefined : /^Bearer\s+(.+)$/i.exec(bearer.trim())
      const token = m?.[1]?.trim() ?? header(headers, 'x-trigger-token')?.trim()
      if (token === undefined || token === '') return { ok: false, reason: 'missing-token' }
      return safeEqual(token, secret) ? { ok: true } : { ok: false, reason: 'bad-token' }
    }
    case 'hmac-sha256': {
      const given = header(headers, 'x-hub-signature-256')?.trim()
      if (given === undefined || !given.startsWith('sha256=')) return { ok: false, reason: 'missing-signature' }
      return safeEqual(given.toLowerCase(), signHubSha256(secret, body)) ? { ok: true } : { ok: false, reason: 'bad-signature' }
    }
    case 'standard-webhooks': {
      const id = header(headers, 'webhook-id'); const ts = header(headers, 'webhook-timestamp'); const sig = header(headers, 'webhook-signature')
      if (id === undefined || ts === undefined || sig === undefined) return { ok: false, reason: 'missing-signature' }
      if (!/^\d{1,12}$/.test(ts.trim())) return { ok: false, reason: 'bad-timestamp' }
      const seconds = Number(ts.trim())
      if (Math.abs(input.now / 1000 - seconds) > TIMESTAMP_TOLERANCE_SEC) return { ok: false, reason: 'stale-timestamp' }
      const expected = signStandardWebhook(secret, id, ts.trim(), body)
      let match = false
      for (const part of sig.trim().split(/\s+/)) if (part.startsWith('v1,') && safeEqual(part, expected)) match = true
      return match ? { ok: true } : { ok: false, reason: 'bad-signature' }
    }
    default: return { ok: false, reason: 'unknown-auth' }
  }
}
