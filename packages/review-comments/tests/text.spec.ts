import { describe, expect, it } from 'vitest'
import { anchorOfSlice, cleanQuote, findSourceLines, locate, matchesOf, project, rangeAt, sliceOfRange, textNodesOf } from '../src/client/text.ts'

function doc(html: string): HTMLElement {
  document.body.innerHTML = `<div id="root">${html}</div>`
  return document.getElementById('root')!
}

describe('text anchoring', () => {
  it('projects visible text, skipping chrome', () => {
    const root = doc('<p>Alpha <button>skip</button>beta</p>')
    expect(project(textNodesOf(root)).text).toBe('Alpha beta')
  })

  it('captures a selection and finds it again (context + occurrence)', () => {
    const root = doc('<p>the cat sat</p><p>the cat ran</p>')
    const p = project(textNodesOf(root))
    const second = p.text.lastIndexOf('cat')
    const a = anchorOfSlice(p, second, second + 3)
    expect(a.occurrence).toBe(1)
    const found = locate(p, a)!
    expect(found.start).toBe(second)
    expect(rangeAt(p, found.start, found.end)!.toString()).toBe('cat')
  })

  it('re-anchors after unrelated text is inserted before (prefix/suffix beat a stale occurrence)', () => {
    const root = doc('<p>x</p><p>needle one</p><p>needle two</p>')
    const before = project(textNodesOf(root))
    const at = before.text.indexOf('needle two') // occurrence 1
    const a = anchorOfSlice(before, at, at + 6)
    root.insertAdjacentHTML('afterbegin', '<p>needle intro</p>') // new earlier match shifts occurrence indices
    const after = project(textNodesOf(root))
    const found = locate(after, a)!
    expect(after.text.slice(found.start, found.end + 4)).toBe('needle two'.slice(0, 10))
    expect(after.text.slice(found.start - 0, found.start + 10)).toBe('needle two')
  })

  it('returns null when the quote is gone', () => {
    const root = doc('<p>nothing here</p>')
    expect(locate(project(textNodesOf(root)), { find: 'zzz', prefix: '', suffix: '', occurrence: 0 })).toBeNull()
  })

  it('maps a DOM range to projected offsets', () => {
    const root = doc('<p>hello <b>big</b> world</p>')
    const p = project(textNodesOf(root))
    const range = document.createRange()
    range.setStart(root.querySelector('b')!.firstChild!, 1)
    range.setEnd(root.querySelector('p')!.lastChild!, 3)
    const s = sliceOfRange(p, range)!
    expect(p.text.slice(s.start, s.end)).toBe('ig wo')
  })

  it('matchesOf counts overlapping matches', () => {
    expect(matchesOf('aaaa', 'aa')).toEqual([0, 1, 2])
  })

  it('cleanQuote trims and collapses blank runs', () => {
    expect(cleanQuote('  a \r\n\n\n\n b  ')).toBe('a\n\n b')
  })
})

describe('markdown source line search', () => {
  const src = '# Project Notes\n\n## Goals\nWe want to **reduce latency** and improve the onboarding flow.\n\n- First item: cache the session token\n- Second item: remove the legacy endpoint\n\n## Risks\nOption B is cheaper, but the vendor lock-in risk is higher.\n'
  it('finds a rendered one-line quote', () => {
    expect(findSourceLines(src, 'reduce latency and improve the onboarding flow')).toEqual({ start: 4, end: 4 })
  })
  it('finds a multi-line list selection', () => {
    expect(findSourceLines(src, 'cache the session token\nremove the legacy endpoint')).toBeNull()
    expect(findSourceLines(src, 'First item: cache the session token Second item: remove the legacy endpoint')).toEqual({ start: 6, end: 7 })
  })
  it('tolerates a selection that starts and ends mid-word', () => {
    expect(findSourceLines(src, 'tency and improve the onb')).toEqual({ start: 4, end: 4 })
    expect(findSourceLines(src, 'ndor lock-in ris')).toEqual({ start: 10, end: 10 })
  })
  it('chooses by occurrence', () => {
    const s = 'dup line\nother\ndup line\n'
    expect(findSourceLines(s, 'dup line', 1)).toEqual({ start: 3, end: 3 })
  })
  it('returns null for unknown text', () => { expect(findSourceLines(src, 'nope nothing')).toBeNull() })
})
