import { afterEach, describe, expect, it } from 'vitest'
import { followTitle } from '../src/client/title.ts'
import { brandTitle } from '../src/shared/title.ts'

describe('brandTitle', () => {
  it('replaces the exact product title', () => {
    expect(brandTitle('DeepSeek Harness')).toBe('ohmydsh')
    expect(brandTitle('DSH Local Build')).toBe('ohmydsh')
  })
  it('keeps the session title prefix the shell adds', () => {
    expect(brandTitle('Fix the login bug — DeepSeek Harness')).toBe('Fix the login bug — ohmydsh')
  })
  it('does not touch a session that is merely about DeepSeek Harness', () => {
    expect(brandTitle('DeepSeek Harness plugins — ohmydsh')).toBe('DeepSeek Harness plugins — ohmydsh')
    expect(brandTitle('How to use DeepSeek Harness')).toBe('How to use DeepSeek Harness')
  })
  it('is idempotent, which is what stops an observer looping', () => {
    for (const t of ['DeepSeek Harness', 'a — DeepSeek Harness', 'ohmydsh', 'x']) expect(brandTitle(brandTitle(t))).toBe(brandTitle(t))
  })
})

describe('followTitle', () => {
  afterEach(() => { document.title = '' })

  it('rebrands now and whenever the shell rewrites the title, without looping', async () => {
    document.title = 'DeepSeek Harness'
    let writes = 0
    const desc = Object.getOwnPropertyDescriptor(Document.prototype, 'title')!
    Object.defineProperty(document, 'title', { configurable: true, get: () => desc.get!.call(document), set: (v: string) => { writes++; desc.set!.call(document, v) } })
    try {
      const stop = followTitle(document)
      expect(document.title).toBe('ohmydsh')
      writes = 0
      document.title = 'My chat — DeepSeek Harness' // the shell's DocumentTitle effect
      await new Promise((r) => setTimeout(r, 20))
      expect(document.title).toBe('My chat — ohmydsh')
      expect(writes).toBe(2) // the shell's write plus exactly one correction
      stop()
      document.title = 'DeepSeek Harness'
      await new Promise((r) => setTimeout(r, 20))
      expect(document.title).toBe('DeepSeek Harness') // disposed: stock behaviour is back
    } finally { delete (document as unknown as Record<string, unknown>)['title'] }
  })
})
