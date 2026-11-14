// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { clip, digestOutputs, parseCellRefs, stripAnsi } from '../src/core/text.ts'

describe('text helpers', () => {
  it('strips ANSI and clips', () => {
    expect(stripAnsi('\u001b[31mred\u001b[0m')).toBe('red')
    expect(clip('a'.repeat(100), 20)).toContain('omitted')
    expect(clip('short', 20)).toBe('short')
  })
  it('digests outputs: text, errors without ANSI, images, rich types', () => {
    const d = digestOutputs([
      { output_type: 'stream', name: 'stdout', text: 'hi\n' },
      { output_type: 'display_data', data: { 'image/png': 'AAA=', 'text/plain': '<Figure size 640x480 with 1 Axes>', 'text/html': '<b>x</b>' }, metadata: {} },
      { output_type: 'error', ename: 'ValueError', evalue: 'bad', traceback: ['\u001b[31mline1\u001b[0m', 'line2'] },
    ])
    expect(d.text).toContain('hi')
    expect(d.text).not.toContain('Figure size')
    expect(d.text).toContain('ValueError: bad')
    expect(d.text).not.toContain('\u001b')
    expect(d.images).toHaveLength(1)
    expect(d.rich).toEqual(['text/html'])
    expect(d.error?.ename).toBe('ValueError')
  })
  it('parses cell refs', () => {
    const ids = ['a', 'b', 'c', 'd']
    expect(parseCellRefs('all', ids)).toEqual(ids)
    expect(parseCellRefs('1-2', ids)).toEqual(['b', 'c'])
    expect(parseCellRefs('0,c', ids)).toEqual(['a', 'c'])
    expect(() => parseCellRefs('9', ids)).toThrow()
    expect(() => parseCellRefs('zz', ids)).toThrow()
  })
})
