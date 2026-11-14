import { describe, expect, it } from 'vitest'
import { subscriptionToolParameters } from '../src/subscription.js'

describe('subscription image tool parameters', () => {

  it('rejects conflicting or unsupported selections instead of silently dropping them', () => {
    expect(() => subscriptionToolParameters('grok-sub', { size: '1024x1024', aspectRatio: '9:16' })).toThrow('either size or aspect_ratio')
    expect(() => subscriptionToolParameters('grok-sub', { imageSize: '4K' })).toThrow('does not support resolution')
    expect(() => subscriptionToolParameters('google-sub', { imageSize: '2K' })).toThrow('does not support resolution')
  })
})
