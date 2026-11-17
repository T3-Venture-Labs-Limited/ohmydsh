// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { generateSecret, isDirectLoopback, secretHint, signHubSha256, signStandardWebhook, verifyWebhook, type AuthInput } from '../../src/host/auth.ts'

const secret = generateSecret()
const body = Buffer.from('{"hello":"world"}')
const now = 1_800_000_000_000
const base = (over: Partial<AuthInput>): AuthInput => ({ auth: 'token', secret, headers: {}, body, remoteAddress: '203.0.113.5', now, ...over })

describe('secrets', () => {
  it('generates whsec_ + 32 random bytes and hints without revealing it', () => {
    expect(secret).toMatch(/^whsec_[A-Za-z0-9+/]{43}=$/)
    expect(Buffer.from(secret.slice(6), 'base64')).toHaveLength(32)
    expect(secretHint(secret)).toMatch(/^whsec_..…..$/)
    expect(secretHint(undefined)).toBeNull()
  })
})

describe('token auth', () => {
  it('accepts Bearer and X-Trigger-Token, rejects wrong or missing', () => {
    expect(verifyWebhook(base({ headers: { authorization: `Bearer ${secret}` } }))).toEqual({ ok: true })
    expect(verifyWebhook(base({ headers: { 'x-trigger-token': secret } }))).toEqual({ ok: true })
    expect(verifyWebhook(base({ headers: { authorization: 'Bearer nope' } }))).toEqual({ ok: false, reason: 'bad-token' })
    expect(verifyWebhook(base({ headers: { 'x-trigger-token': `${secret}x` } }))).toEqual({ ok: false, reason: 'bad-token' })
    expect(verifyWebhook(base({}))).toEqual({ ok: false, reason: 'missing-token' })
    expect(verifyWebhook(base({ secret: undefined, headers: { authorization: 'Bearer ' } }))).toEqual({ ok: false, reason: 'no-secret' })
  })
})

describe('hmac-sha256 (GitHub)', () => {
  it('verifies the hex HMAC of the raw body', () => {
    const sig = signHubSha256(secret, body)
    expect(verifyWebhook(base({ auth: 'hmac-sha256', headers: { 'x-hub-signature-256': sig } }))).toEqual({ ok: true })
    expect(verifyWebhook(base({ auth: 'hmac-sha256', headers: { 'x-hub-signature-256': signHubSha256('other', body) } }))).toEqual({ ok: false, reason: 'bad-signature' })
    expect(verifyWebhook(base({ auth: 'hmac-sha256', body: Buffer.from('{"hello":"World"}'), headers: { 'x-hub-signature-256': sig } }))).toEqual({ ok: false, reason: 'bad-signature' })
    expect(verifyWebhook(base({ auth: 'hmac-sha256', headers: {} }))).toEqual({ ok: false, reason: 'missing-signature' })
  })
})

describe('standard-webhooks', () => {
  const ts = String(Math.floor(now / 1000))
  const headers = (sig: string, t = ts) => ({ 'webhook-id': 'msg_1', 'webhook-timestamp': t, 'webhook-signature': sig })
  it('verifies v1 over id.timestamp.body with the base64-decoded key, among several signatures', () => {
    const sig = signStandardWebhook(secret, 'msg_1', ts, body)
    expect(verifyWebhook(base({ auth: 'standard-webhooks', headers: headers(sig) }))).toEqual({ ok: true })
    expect(verifyWebhook(base({ auth: 'standard-webhooks', headers: headers(`v1,AAAA ${sig}`) }))).toEqual({ ok: true })
  })
  it('matches the svix reference vector', () => {
    // From the Standard Webhooks spec / svix docs.
    const ref = 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw'
    const payload = '{"test": 2432232314}'
    expect(signStandardWebhook(ref, 'msg_p5jXN8AQM9LWM0D4loKWxJek', '1614265330', payload)).toBe('v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=')
  })
  it('rejects a wrong secret, a stale or future timestamp, and missing headers', () => {
    expect(verifyWebhook(base({ auth: 'standard-webhooks', headers: headers(signStandardWebhook(generateSecret(), 'msg_1', ts, body)) }))).toEqual({ ok: false, reason: 'bad-signature' })
    const old = String(Math.floor(now / 1000) - 301)
    expect(verifyWebhook(base({ auth: 'standard-webhooks', headers: headers(signStandardWebhook(secret, 'msg_1', old, body), old) }))).toEqual({ ok: false, reason: 'stale-timestamp' })
    const future = String(Math.floor(now / 1000) + 301)
    expect(verifyWebhook(base({ auth: 'standard-webhooks', headers: headers(signStandardWebhook(secret, 'msg_1', future, body), future) }))).toEqual({ ok: false, reason: 'stale-timestamp' })
    expect(verifyWebhook(base({ auth: 'standard-webhooks', headers: { 'webhook-id': 'x' } }))).toEqual({ ok: false, reason: 'missing-signature' })
  })
})

describe('none (loopback only)', () => {
  it('accepts a direct loopback request only', () => {
    expect(verifyWebhook(base({ auth: 'none', secret: undefined, remoteAddress: '127.0.0.1' }))).toEqual({ ok: true })
    expect(verifyWebhook(base({ auth: 'none', secret: undefined, remoteAddress: '::1' }))).toEqual({ ok: true })
    expect(verifyWebhook(base({ auth: 'none', secret: undefined, remoteAddress: '::ffff:127.0.0.1' }))).toEqual({ ok: true })
    expect(verifyWebhook(base({ auth: 'none', secret: undefined, remoteAddress: '100.64.0.7' }))).toEqual({ ok: false, reason: 'not-loopback' })
  })
  it('rejects loopback peers that are proxies (tailscale serve) or browser pages', () => {
    expect(isDirectLoopback('127.0.0.1', { 'x-forwarded-for': '100.64.0.7' })).toBe(false)
    expect(isDirectLoopback('127.0.0.1', { forwarded: 'for=1.2.3.4' })).toBe(false)
    expect(isDirectLoopback('127.0.0.1', { origin: 'https://evil.example' })).toBe(false)
    expect(isDirectLoopback('127.0.0.1', { 'sec-fetch-site': 'cross-site' })).toBe(false)
    expect(isDirectLoopback('127.0.0.1', { 'user-agent': 'curl/8' })).toBe(true)
  })
})
