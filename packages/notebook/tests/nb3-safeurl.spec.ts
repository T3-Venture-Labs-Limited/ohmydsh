// @vitest-environment node
// NB-3 regression: safeUrl cannot be bypassed with control characters.
import { describe, expect, it } from 'vitest'
import { safeUrl, renderInline } from '../src/client/markdown.ts'

describe('NB-3: safeUrl cannot be bypassed with control characters', () => {
  const bad = ['javascript:alert(1)', 'java\tscript:alert(1)', '\x01javascript:alert(1)', 'java\nscript:alert(1)', 'java\r\nscript:alert(1)', ' \x00javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'jav&#x09;ascript:alert(1)', 'data:text/html,<script>1</script>', 'vbscript:x', '\u200bjavascript:alert(1)', 'file:///etc/passwd']
  it.each(bad)('rejects %j', (raw) => {
    const out = safeUrl(raw)
    if (out !== null) expect(out).not.toMatch(/^[a-z]+:/i) // anything that survives must be a relative reference
    expect(out?.toLowerCase().startsWith('javascript') ?? false).toBe(false)
  })
  it('never emits a javascript href through renderInline', () => {
    for (const raw of ['java\tscript:alert(1)', '\x01javascript:alert(1)', 'java\nscript:alert(1)']) {
      const html = renderInline(`[x](${raw})`)
      expect(html.replace(/[\t\n\r\x00-\x20]/g, '').toLowerCase()).not.toContain('href="javascript:')
    }
  })
  it('keeps legitimate links', () => {
    expect(safeUrl('https://example.com/a?b=c')).toBe('https://example.com/a?b=c')
    expect(safeUrl('http://example.com')).toBe('http://example.com')
    expect(safeUrl('mailto:a@b.co')).toBe('mailto:a@b.co')
    expect(safeUrl('#section')).toBe('#section')
    expect(safeUrl('')).toBeNull()
  })
})

