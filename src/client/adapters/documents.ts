// documentpreview adapter: PDF / Word / PowerPoint (PDF.js text layer), markdown, plain text and code.
// DOM markers are DSH-internal (not a public contract); every lookup degrades to "no capture", never throws.
import type { Anchor, Capture, FileFormat, PageRect, Renderer, ReviewComment, Target } from '../types.ts'
import { anchorOfSlice, cleanQuote, elementOf, NON_QUOTE, project, sliceOfRange, textNodesOf } from '../text.ts'

export const PREVIEW = '[data-document-preview][data-textpreview-url]'
const ADDRESS = /^dsh-resource:\/\/file\/session\/([^/]+)\/([^?#]*)/

const BODY: Partial<Record<Renderer, string>> = {
  pdf: '[data-pdf-preview]',
  office: '[data-pdf-preview]',
  markdown: '[data-document-markdown]',
  text: '[data-textpreview-plain]',
  code: '[data-code-preview] [data-code-block-content]',
}

export function rendererOf(preview: Element): Renderer | null {
  const id = (preview as HTMLElement).dataset.documentPreview ?? ''
  const tail = id.slice(id.lastIndexOf('/') + 1)
  if (tail === 'pdf' || tail === 'office' || tail === 'markdown' || tail === 'text' || tail === 'code' || tail === 'excel') return tail
  for (const [renderer, selector] of Object.entries(BODY) as [Renderer, string][]) if (preview.querySelector(selector) !== null) return renderer
  return null
}

export function formatOf(path: string, renderer: Renderer): FileFormat {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase()
  if (renderer === 'pdf') return 'pdf'
  if (renderer === 'excel') return (['xlsx', 'xls', 'csv', 'tsv'].includes(ext) ? ext : 'xlsx') as FileFormat
  if (renderer === 'office') return (['doc', 'docx', 'ppt', 'pptx'].includes(ext) ? ext : 'docx') as FileFormat
  return renderer === 'markdown' ? 'markdown' : renderer === 'code' ? 'code' : 'text'
}

export function parseAddress(address: string): { sessionId: string; path: string } | null {
  const match = ADDRESS.exec(address)
  if (match === null) return null
  try { return { sessionId: decodeURIComponent(match[1]!), path: match[2]!.split('/').map(decodeURIComponent).join('/') } } catch { return null }
}

export interface PreviewHit {
  preview: HTMLElement
  body: HTMLElement
  renderer: Renderer
  address: string
  sessionId: string
  path: string
  /** The tab chrome that clips this preview (scroll port). */
  viewer: HTMLElement
}

export function previewHitOf(node: Node): PreviewHit | null {
  const preview = elementOf(node)?.closest<HTMLElement>(PREVIEW)
  if (!preview) return null
  const renderer = rendererOf(preview)
  if (renderer === null) return null
  const selector = BODY[renderer]
  const body = selector === undefined ? null : preview.querySelector<HTMLElement>(selector)
  const address = preview.dataset.textpreviewUrl ?? ''
  const parsed = parseAddress(address)
  if (!body || !parsed) return null
  return { preview, body, renderer, address, sessionId: parsed.sessionId, path: parsed.path, viewer: preview.closest<HTMLElement>('[data-sidebar-right-tab]') ?? preview }
}

/** Rect list for a range: client rects joined per line, so a three-line selection is three boxes. */
export function mergeRects(rects: DOMRect[]): { left: number; top: number; right: number; bottom: number }[] {
  const boxes = rects.filter(r => r.width > 0.5 && r.height > 0.5).map(r => ({ left: r.left, top: r.top, right: r.right, bottom: r.bottom }))
  boxes.sort((a, b) => a.top - b.top || a.left - b.left)
  const out: typeof boxes = []
  for (const box of boxes) {
    const last = out[out.length - 1]
    const sameLine = last !== undefined && Math.abs(last.top - box.top) < 3 && Math.abs(last.bottom - box.bottom) < 4
    if (last !== undefined && sameLine && box.left <= last.right + 4) {
      last.right = Math.max(last.right, box.right); last.top = Math.min(last.top, box.top); last.bottom = Math.max(last.bottom, box.bottom)
    } else out.push({ ...box })
  }
  return out
}

function pdfRects(range: Range, body: HTMLElement): { rects: PageRect[]; pages: number[] } {
  const pages = [...body.querySelectorAll<HTMLElement>('[data-pdf-page]')]
  const merged = mergeRects([...range.getClientRects()])
  const rects: PageRect[] = []
  const seen = new Set<number>()
  for (const box of merged) {
    const cx = (box.left + box.right) / 2
    const cy = (box.top + box.bottom) / 2
    const page = pages.find(el => { const r = el.getBoundingClientRect(); return cx >= r.left && cx <= r.right && cy >= r.top && cy <= r.bottom })
    if (page === undefined) continue
    const r = page.getBoundingClientRect()
    if (r.width === 0 || r.height === 0) continue
    const number = Number(page.dataset.pdfPage)
    seen.add(number)
    rects.push({ page: number, x: (box.left - r.left) / r.width, y: (box.top - r.top) / r.height, w: (box.right - box.left) / r.width, h: (box.bottom - box.top) / r.height })
  }
  return { rects: rects.slice(0, 200), pages: [...seen] }
}

/** Source lines of a selection in plain text (data attribute per row) or code (`.line` index). */
function lineSpan(hit: PreviewHit, range: Range): { start: number; end: number } | null {
  const rowOf = (node: Node, offset: number, atEnd: boolean): number | null => {
    let el = elementOf(node)
    if (node instanceof Element && atEnd && offset === 0 && node.previousElementSibling) el = node.previousElementSibling
    if (el === null) return null
    if (hit.renderer === 'text') {
      const row = el.closest<HTMLElement>('[data-textpreview-line]')
      return row ? Number(row.dataset.textpreviewLine) : null
    }
    const line = el.closest<HTMLElement>('.line')
    if (!line) return null
    const lines = [...hit.body.querySelectorAll('pre .line')]
    const index = lines.indexOf(line)
    return index === -1 ? null : index + 1
  }
  const start = rowOf(range.startContainer, range.startOffset, false)
  let end = rowOf(range.endContainer, range.endOffset, true)
  if (start === null) return null
  if (end === null) end = start
  return { start: Math.min(start, end), end: Math.max(start, end) }
}

export interface DocumentCaptureDeps {
  /** Source text reader for markdown line search. */
  readSource(sessionId: string, path: string): Promise<string | null>
  findLines(source: string, quote: string, occurrence: number): { start: number; end: number } | null
}

export function captureDocument(selection: Selection, deps: DocumentCaptureDeps): Capture | null {
  if (selection.isCollapsed || selection.rangeCount !== 1) return null
  const range = selection.getRangeAt(0)
  const hit = previewHitOf(range.startContainer)
  const endHit = previewHitOf(range.endContainer)
  if (hit === null || endHit === null || hit.preview !== endHit.preview) return null
  if (!hit.body.contains(range.startContainer) || !hit.body.contains(range.endContainer)) return null
  if (elementOf(range.commonAncestorContainer)?.closest(NON_QUOTE)) return null

  const pdf = hit.renderer === 'pdf' || hit.renderer === 'office'
  const within = pdf ? '[data-pdf-text]' : undefined
  const nodes = textNodesOf(hit.body, within)

  let anchor: Anchor
  let scope = nodes
  let slice: { start: number; end: number } | null
  if (pdf) {
    const { rects, pages } = pdfRects(range, hit.body)
    if (pages.length === 0 || rects.length === 0) return null
    const first = Math.min(...pages)
    anchor = { kind: 'pdf', page: first, pageEnd: Math.max(...pages), rects }
    // Context and occurrence are computed on the first page's text layer; a multi-page quote is anchored by its start.
    scope = nodes.filter(node => Number(node.parentElement?.closest<HTMLElement>('[data-pdf-page]')?.dataset.pdfPage) === first)
    const startRange = range.cloneRange()
    const pageEl = hit.body.querySelector<HTMLElement>(`[data-pdf-page="${first}"]`)
    if (pageEl && !pageEl.contains(range.endContainer)) { startRange.selectNodeContents(pageEl); startRange.setStart(range.startContainer, range.startOffset) }
    slice = sliceOfRange(project(scope), startRange)
  } else {
    const lines = hit.renderer === 'markdown' ? null : lineSpan(hit, range)
    anchor = { kind: 'lines', start: lines?.start ?? 0, end: lines?.end ?? 0, hint: lines ? 'exact' : 'none' }
    slice = sliceOfRange(project(nodes), range)
  }
  if (slice === null) return null
  const projection = project(scope)
  const ta = anchorOfSlice(projection, slice.start, slice.end)
  if (ta.find.trim() === '') return null
  const browserText = cleanQuote(selection.toString())
  const norm = (s: string): string => s.replace(/\s+/g, '')
  const quote = norm(browserText).includes(norm(ta.find)) || browserText === '' ? (browserText === '' ? cleanQuote(ta.find) : browserText) : cleanQuote(ta.find)

  const target: Target = { kind: 'file', path: hit.path, address: hit.address, renderer: hit.renderer, format: formatOf(hit.path, hit.renderer) }
  const capture: Capture = { sessionId: hit.sessionId, target, anchor, quote, ...ta, range: range.cloneRange(), viewer: hit.viewer }
  if (hit.renderer === 'markdown') {
    capture.resolveAnchor = async (): Promise<Anchor> => {
      const source = await deps.readSource(hit.sessionId, hit.path)
      const found = source === null ? null : deps.findLines(source, quote, ta.occurrence)
      return found ? { kind: 'lines', start: found.start, end: found.end, hint: 'searched' } : { kind: 'lines', start: 0, end: 0, hint: 'none' }
    }
  }
  return capture
}

export interface LocatedText { range: Range }

/** Rebuild the DOM range of a stored text comment inside its preview body. */
export function bodyFor(preview: HTMLElement, comment: ReviewComment): HTMLElement | null {
  const renderer = rendererOf(preview)
  if (renderer === null) return null
  const selector = BODY[renderer]
  return selector === undefined ? null : preview.querySelector<HTMLElement>(selector)
}
