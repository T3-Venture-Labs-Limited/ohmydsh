// EXPERIMENTAL, DOM-level, read-only adapter for dsh-better-sidebar's file editor (the viewer that opens .md and code
// files in this profile). better-sidebar exposes no selection hook (see docs/upstream-better-sidebar-selection.md),
// so this reads its DOM. Rules: never write into its DOM (we only paint through the CSS Custom Highlight API and our
// own overlay layer); no-op whenever a marker is missing; gated by runtime.betterSidebarEnabled().
import type { Anchor, Capture, Renderer, Target } from '../types.ts'
import { anchorOfSlice, cleanQuote, elementOf, NON_QUOTE, project, sliceOfRange, textNodesOf } from '../text.ts'
import { parseAddress, formatOf } from './documents.ts'
import { runtime } from '../runtime.ts'

/** The wrapper better-sidebar puts around every native tab body it renders. */
export const BS_HOST = '[data-dsh-native-tab-host]'
const CM = '.cm-editor'
/** CodeMirror's content element is contenteditable, so the generic chrome filter would drop all of it. */
const CM_REJECT = 'button, input, textarea, select, [data-drc-ui], .cm-gutters'
export const bsTextNodes = (hit: { body: HTMLElement; mode: 'editor' | 'preview' }): Text[] => textNodesOf(hit.body, undefined, hit.mode === 'editor' ? CM_REJECT : undefined)

/** The slice of CodeMirror's EditorView we read. */
interface CmView {
  state: { doc: { lineAt(pos: number): { number: number }; sliceString(from: number, to: number): string; lines: number } }
  posAtDOM(node: Node, offset?: number): number
}

/** Retrieve the EditorView from its DOM: `.cm-content.cmTile.root.view` (6.43+) or `.cmView` (older 6.x). */
export function cmViewOf(editor: Element): CmView | null {
  const content = editor.querySelector<HTMLElement & { cmTile?: { root?: { view?: CmView } }; cmView?: { view?: CmView; rootView?: CmView } }>('.cm-content')
  if (content === null) return null
  const view = content.cmTile?.root?.view ?? content.cmView?.view ?? content.cmView?.rootView ?? null
  return view !== null && typeof view.posAtDOM === 'function' && typeof view.state?.doc?.lineAt === 'function' ? view : null
}

export interface BsHit {
  host: HTMLElement
  /** The element whose text nodes make up the document. */
  body: HTMLElement
  mode: 'editor' | 'preview'
  editor: HTMLElement | null
  address: string
  sessionId: string
  path: string
  renderer: Renderer
  viewer: HTMLElement
}

/** Identify the file a better-sidebar host shows: public tab inventory first, header path input as a fallback. */
export function identifyHost(host: HTMLElement): { address: string; sessionId: string; path: string } | null {
  const tabId = host.closest<HTMLElement>('[data-sidebar-right-tab]')?.dataset.sidebarRightTab
  const sessionId = host.closest<HTMLElement>('[data-sidebar-right-session]')?.dataset.sidebarRightSession ?? ''
  if (tabId !== undefined) {
    const address = runtime.addressOfTab(tabId)
    const parsed = address === undefined ? null : parseAddress(address)
    if (address !== undefined && parsed !== null) return { address, sessionId: parsed.sessionId, path: parsed.path }
  }
  const shown = host.querySelector<HTMLInputElement>('input[type="text"], input:not([type])')?.value ?? ''
  if (sessionId === '' || shown === '') return null
  return { address: `bs-path:${sessionId}:${shown}`, sessionId, path: shown }
}

function isMarkdownPath(path: string): boolean { return /\.(md|markdown)$/i.test(path) }

/** The better-sidebar editor host that contains `node`, or null (flag off, version out of range, markers missing). */
export function bsHitOf(node: Node): BsHit | null {
  if (!runtime.betterSidebarEnabled()) return null
  const el = elementOf(node)
  const host = el?.closest<HTMLElement>(BS_HOST)
  if (!host) return null
  // documentpreview owns its own DOM; never double-capture a tab it renders.
  if (host.querySelector('[data-document-preview]') !== null) return null
  const who = identifyHost(host)
  if (who === null) return null
  const editor = host.querySelector<HTMLElement>(CM)
  const viewer = host.closest<HTMLElement>('[data-sidebar-right-tab]') ?? host
  if (editor !== null && editor.contains(el)) {
    const content = editor.querySelector<HTMLElement>('.cm-content')
    if (content === null) return null
    return { host, body: content, mode: 'editor', editor, ...who, renderer: 'bs-code', viewer }
  }
  // Markdown preview: the rendered document is the host's content outside the header controls. The editor host can stay
  // mounted (hidden) in preview mode, so only a selection that is outside it counts.
  if (isMarkdownPath(who.path)) return { host, body: host, mode: 'preview', editor: null, ...who, renderer: 'bs-markdown', viewer }
  return null
}

/** Exact 1-based line span of a CodeMirror selection, via posAtDOM; null when the view cannot be reached. */
function editorLines(editor: HTMLElement, range: Range): { start: number; end: number; quote: string } | null {
  const view = cmViewOf(editor)
  if (view === null) return null
  try {
    const a = view.posAtDOM(range.startContainer, range.startOffset)
    const b = view.posAtDOM(range.endContainer, range.endOffset)
    const from = Math.min(a, b)
    let to = Math.max(a, b)
    if (to === from) return null
    const quote = view.state.doc.sliceString(from, to)
    // A selection that ends right after a newline belongs to the previous line.
    if (quote.endsWith('\n')) to -= 1
    return { start: view.state.doc.lineAt(from).number, end: view.state.doc.lineAt(Math.max(from, to)).number, quote }
  } catch { return null }
}

export interface BsCaptureDeps {
  readSource(sessionId: string, path: string): Promise<string | null>
  findLines(source: string, quote: string, occurrence: number): { start: number; end: number } | null
}

export function captureBetterSidebar(selection: Selection, deps: BsCaptureDeps): Capture | null {
  if (selection.isCollapsed || selection.rangeCount !== 1) return null
  const range = selection.getRangeAt(0)
  const hit = bsHitOf(range.startContainer)
  const end = bsHitOf(range.endContainer)
  if (hit === null || end === null || hit.host !== end.host || hit.mode !== end.mode) return null
  if (!hit.body.contains(range.startContainer) || !hit.body.contains(range.endContainer)) return null
  if (elementOf(range.commonAncestorContainer)?.closest(NON_QUOTE) && hit.mode === 'preview') return null

  const p = project(bsTextNodes(hit))
  const slice = sliceOfRange(p, range)
  if (slice === null) return null
  const ta = anchorOfSlice(p, slice.start, slice.end)
  if (ta.find.trim() === '') return null

  const exact = hit.mode === 'editor' && hit.editor !== null ? editorLines(hit.editor, range) : null
  const browser = cleanQuote(selection.toString())
  const quote = exact !== null ? exact.quote.replace(/\r\n?/g, '\n').replace(/\n+$/g, '') : (browser !== '' ? browser : cleanQuote(ta.find))
  const anchor: Anchor = exact !== null
    ? { kind: 'lines', start: exact.start, end: exact.end, hint: 'exact' }
    : { kind: 'lines', start: 0, end: 0, hint: 'none' }
  const target: Target = { kind: 'file', path: hit.path, address: hit.address, renderer: hit.renderer, format: formatOf(hit.path, hit.mode === 'preview' ? 'markdown' : 'code') }
  const capture: Capture = { sessionId: hit.sessionId, target, anchor, quote, ...ta, range: range.cloneRange(), viewer: hit.viewer }
  // No reachable EditorView (or rendered markdown): search the file source for the quote; the quote is only a location reference.
  if (exact === null) {
    capture.resolveAnchor = async (): Promise<Anchor> => {
      const source = await deps.readSource(hit.sessionId, hit.path)
      const found = source === null ? null : deps.findLines(source, quote, ta.occurrence)
      return found ? { kind: 'lines', start: found.start, end: found.end, hint: 'searched' } : { kind: 'lines', start: 0, end: 0, hint: 'none' }
    }
  }
  return capture
}

/** Every visible better-sidebar host showing `address`, with the element whose text carries the document. */
export function bsBodiesFor(address: string, root: ParentNode = document): { host: HTMLElement; body: HTMLElement }[] {
  if (!runtime.betterSidebarEnabled()) return []
  const out: { host: HTMLElement; body: HTMLElement }[] = []
  for (const host of root.querySelectorAll<HTMLElement>(BS_HOST)) {
    if (host.querySelector('[data-document-preview]') !== null) continue
    if (identifyHost(host)?.address !== address) continue
    const content = host.querySelector<HTMLElement>(`${CM} .cm-content`)
    out.push({ host, body: content ?? host })
  }
  return out
}
