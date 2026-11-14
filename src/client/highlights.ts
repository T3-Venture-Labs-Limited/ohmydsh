// Resolve stored comments back to live DOM: text comments become Ranges for the CSS Custom Highlight API, PDF comments
// become page-relative rect boxes (the text layer is rebuilt on zoom/re-render, so fractions are more robust).
import type { PageRect, ReviewComment } from './types.ts'
import { locate, project, rangeAt, textNodesOf } from './text.ts'
import { chatBodiesFor } from './adapters/chat.ts'
import { PREVIEW } from './adapters/documents.ts'
import { bsBodiesFor, bsTextNodes } from './adapters/bettersidebar.ts'

export interface ResolvedBox { id: string; left: number; top: number; width: number; height: number; clip: { left: number; top: number; right: number; bottom: number } }
export interface Resolved { ranges: Map<string, Range[]>; boxes: ResolvedBox[]; anchors: Map<string, { left: number; top: number; right: number; bottom: number }> }

function previewsFor(comment: ReviewComment, root: ParentNode): HTMLElement[] {
  if (comment.target.kind !== 'file') return []
  const address = comment.target.address
  return [...root.querySelectorAll<HTMLElement>(PREVIEW)].filter(el => el.dataset.textpreviewUrl === address && el.checkVisibility?.() !== false)
}

function rectOfClip(el: Element): { left: number; top: number; right: number; bottom: number } {
  const r = el.getBoundingClientRect()
  return { left: r.left, top: r.top, right: r.right, bottom: r.bottom }
}

export function resolveComments(comments: readonly ReviewComment[], root: ParentNode = document): Resolved {
  const out: Resolved = { ranges: new Map(), boxes: [], anchors: new Map() }
  for (const comment of comments) {
    if (comment.status === 'resolved') continue
    if (comment.anchor.kind === 'cells') continue // canvas grid: nothing to paint
    if (comment.anchor.kind === 'message') {
      for (const body of chatBodiesFor(comment, root)) {
        const p = project(textNodesOf(body))
        const found = locate(p, comment)
        const range = found && rangeAt(p, found.start, found.end)
        if (range) out.ranges.set(comment.id, [...(out.ranges.get(comment.id) ?? []), range])
      }
      continue
    }
    if (comment.target.kind === 'file' && (comment.target.renderer === 'bs-code' || comment.target.renderer === 'bs-markdown')) {
      for (const { host, body } of bsBodiesFor(comment.target.address, root)) {
        if (host.checkVisibility?.() === false) continue
        const mode = body.classList.contains('cm-content') ? 'editor' as const : 'preview' as const
        const p = project(bsTextNodes({ body, mode }))
        const found = locate(p, comment)
        const range = found && rangeAt(p, found.start, found.end)
        if (range) out.ranges.set(comment.id, [...(out.ranges.get(comment.id) ?? []), range])
      }
      continue
    }
    for (const preview of previewsFor(comment, root)) {
      const clip = rectOfClip(preview.querySelector<HTMLElement>('[data-document-zoom-scrollport]') ?? preview)
      if (comment.anchor.kind === 'pdf') {
        const rects: PageRect[] = comment.anchor.rects
        for (const rect of rects) {
          const page = preview.querySelector<HTMLElement>(`[data-pdf-page="${rect.page}"]`)
          if (page === null) continue
          const r = page.getBoundingClientRect()
          if (r.width === 0) continue
          out.boxes.push({ id: comment.id, left: r.left + rect.x * r.width, top: r.top + rect.y * r.height, width: rect.w * r.width, height: rect.h * r.height, clip })
        }
        continue
      }
      const body = preview.querySelector<HTMLElement>('[data-pdf-preview], [data-document-markdown], [data-textpreview-plain], [data-code-preview] [data-code-block-content]')
      if (body === null) continue
      const p = project(textNodesOf(body))
      const found = locate(p, comment)
      const range = found && rangeAt(p, found.start, found.end)
      if (range) out.ranges.set(comment.id, [...(out.ranges.get(comment.id) ?? []), range])
    }
  }
  return out
}

interface HighlightRegistry { set(name: string, highlight: unknown): void; delete(name: string): void }
type HighlightCtor = new (...ranges: Range[]) => unknown

export function paintHighlights(resolved: Resolved, activeId: string | null): () => void {
  const registry = (globalThis.CSS as unknown as { highlights?: HighlightRegistry } | undefined)?.highlights
  const Ctor = (globalThis as unknown as { Highlight?: HighlightCtor }).Highlight
  if (registry === undefined || Ctor === undefined) return () => {}
  const all: Range[] = []
  const active: Range[] = []
  for (const [id, ranges] of resolved.ranges) (id === activeId ? active : all).push(...ranges)
  registry.set('drc-comment', new Ctor(...all))
  registry.set('drc-active', new Ctor(...active))
  return () => { registry.delete('drc-comment'); registry.delete('drc-active') }
}
