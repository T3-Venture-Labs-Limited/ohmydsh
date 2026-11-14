// One document-level selection pipeline for every viewer. Adapters turn a DOM selection into a Capture;
// the controller publishes the latest valid one to the floating UI through a tiny external store.
import type { Capture } from './types.ts'
import type { Ctx } from './host.ts'
import { currentSessionId, readSource } from './host.ts'
import { captureDocument } from './adapters/documents.ts'
import { captureChat } from './adapters/chat.ts'
import { captureBetterSidebar } from './adapters/bettersidebar.ts'
import { captureExcel, EXCEL } from './adapters/excel.ts'
import { findSourceLines } from './text.ts'

export interface SelectionController {
  getSnapshot(): Capture | null
  subscribe(listener: () => void): () => void
  /** Drop the published capture and the browser selection. */
  clear(): void
  /** Freeze the capture while the popover is open (focus moving to its textarea collapses the browser selection). */
  hold(held: boolean): void
  dispose(): void
}

function same(a: Capture | null, b: Capture | null): boolean {
  if (a === null || b === null) return a === b
  if (a.anchor.kind === 'cells' && b.anchor.kind === 'cells') return a.sessionId === b.sessionId && a.target.kind === 'file' && b.target.kind === 'file' && a.target.address === b.target.address
    && a.anchor.sheet === b.anchor.sheet && a.anchor.range === b.anchor.range && a.quote === b.quote
  return a.sessionId === b.sessionId && a.find === b.find && a.occurrence === b.occurrence
    && a.range.startContainer === b.range.startContainer && a.range.startOffset === b.range.startOffset
    && a.range.endContainer === b.range.endContainer && a.range.endOffset === b.range.endOffset
}

/** Where the user last pressed inside a spreadsheet; the sheet draws on a canvas, so there is no text range to anchor to. */
let lastSheetPoint: { x: number; y: number } | undefined

export function captureNow(ctx: Ctx): Capture | null {
  const sheet = captureSheet()
  if (sheet !== null) return sheet
  const selection = window.getSelection()
  if (selection === null || selection.isCollapsed || selection.rangeCount === 0) return null
  const deps = { readSource: (sessionId: string, path: string) => readSource(ctx, sessionId, path), findLines: findSourceLines }
  try { return captureDocument(selection, deps) ?? captureBetterSidebar(selection, deps) ?? captureChat(selection, currentSessionId(ctx)) } catch (error) {
    console.warn('[dsh-review-comments] capture failed', error)
    return null
  }
}

/** A spreadsheet selection exists only while the pointer last landed in a visible sheet; clicking elsewhere clears it. */
function captureSheet(): Capture | null {
  if (lastSheetPoint === undefined) return null
  const el = document.elementFromPoint(lastSheetPoint.x, lastSheetPoint.y)
  if (el === null || el.closest(EXCEL) === null) return null
  // Only the cell grid and name box count; tabs and the formula bar are chrome.
  if (el.closest('.luckysheet-sheet-area, .fortune-fx-editor, .fortune-fx-input, .fortune-name-box-container') !== null) return null
  return captureExcel(el)
}

export function createSelectionController(ctx: Ctx): SelectionController {
  let current: Capture | null = null
  let held = false
  let frame = 0
  const listeners = new Set<() => void>()
  const set = (next: Capture | null): void => {
    if (same(current, next)) return
    current = next
    for (const listener of [...listeners]) listener()
  }
  const recompute = (): void => {
    frame = 0
    if (held) return
    set(captureNow(ctx))
  }
  const schedule = (): void => { if (frame === 0) frame = requestAnimationFrame(recompute) }
  const onPointerDown = (event: PointerEvent): void => {
    const el = event.target instanceof Element ? event.target : null
    lastSheetPoint = el !== null && el.closest(EXCEL) !== null ? { x: event.clientX, y: event.clientY } : undefined
  }
  const onKey = (event: KeyboardEvent): void => {
    if (event.key === 'Escape' && current !== null && !held) { window.getSelection()?.removeAllRanges(); lastSheetPoint = undefined; set(null) }
    else schedule()
  }
  document.addEventListener('selectionchange', schedule)
  document.addEventListener('pointerdown', onPointerDown, true)
  document.addEventListener('pointerup', schedule)
  document.addEventListener('keyup', onKey)
  return {
    getSnapshot: () => current,
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener) } },
    clear() { held = false; window.getSelection()?.removeAllRanges(); set(null) },
    hold(value) { held = value; if (!value) schedule() },
    dispose() {
      document.removeEventListener('selectionchange', schedule)
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('pointerup', schedule)
      document.removeEventListener('keyup', onKey)
      if (frame !== 0) cancelAnimationFrame(frame)
      listeners.clear()
    },
  }
}
