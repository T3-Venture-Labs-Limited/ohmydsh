// Text-node projection helpers: capture a selection as plain text with stable context, and find it again later.
// These are pure DOM functions (no host knowledge) so they are unit-testable with jsdom fixtures.

/** Interactive chrome and our own UI never count as document text. */
export const NON_QUOTE = 'button, [role="button"], input, textarea, select, [contenteditable="true"], [data-code-block-banner], [data-drc-ui]'

export const CONTEXT_CHARS = 40

export function elementOf(node: Node): Element | null {
  return node instanceof Element ? node : node.parentElement
}

/** `checkVisibility` is missing in jsdom: treat unknown as visible. */
export function isVisible(el: Element): boolean {
  const check = (el as Element & { checkVisibility?: (options?: object) => boolean }).checkVisibility
  return check === undefined ? true : check.call(el, { visibilityProperty: true })
}

export interface Projection { nodes: Text[]; starts: number[]; text: string }

/** Visible text nodes under `root`, optionally limited to descendants of a `within` selector. */
export function textNodesOf(root: Element, within?: string, reject: string = NON_QUOTE): Text[] {
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement
      if (parent === null || parent.closest(reject) !== null) return NodeFilter.FILTER_REJECT
      if (within !== undefined && parent.closest(within) === null) return NodeFilter.FILTER_REJECT
      return NodeFilter.FILTER_ACCEPT
    },
  })
  const nodes: Text[] = []
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) nodes.push(node as Text)
  return nodes
}

export function project(nodes: Text[]): Projection {
  const starts: number[] = []
  let at = 0
  let text = ''
  for (const node of nodes) { starts.push(at); text += node.data; at += node.data.length }
  return { nodes, starts, text }
}

/** The projected offsets covered by a range (only nodes with a non-empty overlap count). */
export function sliceOfRange(p: Projection, range: Range): { start: number; end: number } | null {
  let start = -1
  let end = -1
  p.nodes.forEach((node, index) => {
    if (!range.intersectsNode(node)) return
    const from = node === range.startContainer ? range.startOffset : 0
    const to = node === range.endContainer ? range.endOffset : node.data.length
    if (to <= from) return
    if (start === -1) start = p.starts[index]! + from
    end = p.starts[index]! + to
  })
  return start === -1 ? null : { start, end }
}

/** Every start offset of `needle`, overlapping matches included so capture and lookup agree. */
export function matchesOf(haystack: string, needle: string): number[] {
  const found: number[] = []
  if (needle === '') return found
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + 1)) found.push(at)
  return found
}

export interface TextAnchor { find: string; prefix: string; suffix: string; occurrence: number }

export function anchorOfSlice(p: Projection, start: number, end: number): TextAnchor {
  const find = p.text.slice(start, end)
  return {
    find,
    prefix: p.text.slice(Math.max(0, start - CONTEXT_CHARS), start),
    suffix: p.text.slice(end, end + CONTEXT_CHARS),
    occurrence: matchesOf(p.text, find).filter(at => at < start).length,
  }
}

function commonSuffix(a: string, b: string): number {
  let n = 0
  while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n += 1
  return n
}
function commonPrefix(a: string, b: string): number {
  let n = 0
  while (n < a.length && n < b.length && a[n] === b[n]) n += 1
  return n
}

/** Find the stored text again: best prefix/suffix agreement wins, the recorded occurrence breaks ties. */
export function locate(p: Projection, a: TextAnchor): { start: number; end: number } | null {
  const positions = matchesOf(p.text, a.find)
  if (positions.length === 0) return null
  let best = Math.min(a.occurrence, positions.length - 1)
  let bestScore = -1
  positions.forEach((at, index) => {
    const score = commonSuffix(p.text.slice(0, at), a.prefix) + commonPrefix(p.text.slice(at + a.find.length), a.suffix)
    if (score > bestScore || (score === bestScore && index === a.occurrence)) { best = index; bestScore = score }
  })
  const start = positions[best]!
  return { start, end: start + a.find.length }
}

/** A DOM range for projected offsets `[start, end)`. */
export function rangeAt(p: Projection, start: number, end: number): Range | null {
  const doc = p.nodes[0]?.ownerDocument
  if (doc === undefined) return null
  let startNode = -1
  let endNode = -1
  p.nodes.forEach((node, index) => {
    const from = p.starts[index]!
    const to = from + node.data.length
    if (startNode === -1 && start >= from && start < to) startNode = index
    if (end > from && end <= to) endNode = index
  })
  if (startNode === -1 || endNode === -1) return null
  const range = doc.createRange()
  range.setStart(p.nodes[startNode]!, start - p.starts[startNode]!)
  range.setEnd(p.nodes[endNode]!, end - p.starts[endNode]!)
  return range
}

/** The selection text as the reviewer copied it, without runaway blank lines. */
export function cleanQuote(text: string): string {
  return text.replace(/\r\n?/g, '\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
}

// ---- Source line search (markdown) ----------------------------------------------------------------------

const WORD = /[\p{L}\p{N}]+/gu
const HEAD = 8

export function wordsOf(text: string): string[] {
  return (text.toLowerCase().match(WORD) ?? [])
}

/**
 * Locate a rendered quote in markdown source by its word stream, ignoring punctuation and markup.
 * `occurrence` chooses between identical matches. Returns 1-based inclusive lines, or null.
 */
export function findSourceLines(source: string, quote: string, occurrence = 0): { start: number; end: number } | null {
  const q = wordsOf(quote)
  if (q.length === 0) return null
  const stream: { word: string; line: number }[] = []
  source.split(/\r?\n/).forEach((text, index) => { for (const word of wordsOf(text)) stream.push({ word, line: index + 1 }) })
  // The selection may begin or end mid-word, so the first query word may be a suffix and the last a prefix of the source word.
  const match = (sourceWord: string | undefined, word: string, role: 'first' | 'last' | 'both' | 'mid'): boolean => {
    if (sourceWord === undefined) return false
    if (role === 'mid') return sourceWord === word
    if (role === 'first') return sourceWord.endsWith(word)
    if (role === 'last') return sourceWord.startsWith(word)
    return sourceWord.includes(word)
  }
  const roleOf = (index: number, count: number): 'first' | 'last' | 'both' | 'mid' => count === 1 ? 'both' : index === 0 ? 'first' : index === count - 1 ? 'last' : 'mid'
  const head = q.slice(0, HEAD)
  const tail = q.slice(-HEAD)
  const headEqual = (at: number): boolean => head.every((word, i) => match(stream[at + i]?.word, word, q.length <= HEAD ? roleOf(i, q.length) : (i === 0 ? 'first' : 'mid')))
  const tailEqual = (at: number): boolean => tail.every((word, i) => match(stream[at + i]?.word, word, i === tail.length - 1 ? (tail.length === 1 ? 'both' : 'last') : 'mid'))
  const hits: { start: number; end: number }[] = []
  for (let i = 0; i + head.length <= stream.length; i += 1) {
    if (!headEqual(i)) continue
    let last = -1
    if (q.length <= HEAD) last = i + q.length - 1
    else {
      const expected = i + q.length - tail.length
      for (let shift = 0; shift <= 12 && last === -1; shift += 1) {
        for (const at of [expected + shift, expected - shift]) if (at >= i && tailEqual(at)) { last = at + tail.length - 1; break }
      }
    }
    if (last !== -1 && last < stream.length) hits.push({ start: stream[i]!.line, end: stream[last]!.line })
  }
  if (hits.length === 0) return null
  return hits[Math.min(occurrence, hits.length - 1)]!
}
