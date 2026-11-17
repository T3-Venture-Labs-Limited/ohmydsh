// Spreadsheet adapter (xlsx / xls / csv / tsv in documentpreview). FortuneSheet draws cells on a <canvas>, so there is
// no text to select and no highlight to paint. We read what its own chrome shows: the name box (the selected range),
// the formula bar (the active cell's value or formula) and the active sheet tab. Read-only; selectors are DSH/FortuneSheet
// internals and every lookup degrades to "no capture".
import type { Anchor, Capture, Target } from '../types.ts'
import { elementOf } from '../text.ts'
import { formatOf, parseAddress, PREVIEW } from './documents.ts'

export const EXCEL = '[data-excel-preview]'

const A1 = /^\$?[A-Za-z]{1,3}\$?\d{1,7}(?::\$?[A-Za-z]{1,3}\$?\d{1,7})?$/

/** Normalise a name-box value ("b7:c9", "$B$7") to canonical A1 ("B7:C9"); null when it is not a cell range. */
export function normalizeRange(text: string): string | null {
  const cleaned = text.replace(/\s+/g, '').replace(/\$/g, '')
  if (!A1.test(text.replace(/\s+/g, ''))) return null
  const [from, to] = cleaned.toUpperCase().split(':') as [string, string | undefined]
  return to === undefined || to === from ? from : `${from}:${to}`
}

export interface ExcelHit { preview: HTMLElement; root: HTMLElement; address: string; sessionId: string; path: string; viewer: HTMLElement }

export function excelHitOf(node: Node): ExcelHit | null {
  const el = elementOf(node)
  const root = el?.closest<HTMLElement>(EXCEL)
  const preview = root?.closest<HTMLElement>(PREVIEW)
  if (!root || !preview) return null
  const address = preview.dataset.textpreviewUrl ?? ''
  const parsed = parseAddress(address)
  if (parsed === null) return null
  return { preview, root, address, sessionId: parsed.sessionId, path: parsed.path, viewer: preview.closest<HTMLElement>('[data-sidebar-right-tab]') ?? preview }
}

export interface CellInfo { sheet: string; range: string; cellText: string; formula?: string }

/** Read the current selection from FortuneSheet's chrome. */
export function readCells(root: HTMLElement): CellInfo | null {
  const range = normalizeRange(root.querySelector('.fortune-name-box')?.textContent ?? '')
  if (range === null) return null
  const sheet = (root.querySelector('.luckysheet-sheets-item-active .luckysheet-sheets-item-name')?.textContent
    ?? root.querySelector('.luckysheet-sheets-item-active')?.textContent ?? '').trim()
  if (sheet === '') return null
  // The formula bar is a contenteditable div; `innerText` keeps line breaks of multi-line cells.
  const bar = root.querySelector<HTMLElement>('.fortune-fx-input')
  const raw = (bar?.innerText ?? bar?.textContent ?? '').replace(/\u00a0/g, ' ').trim()
  const isFormula = raw.startsWith('=')
  return { sheet, range, cellText: isFormula ? '' : raw, ...(isFormula ? { formula: raw } : {}) }
}

/** The pointer is over the sheet area (not the tabs or formula bar), so a click there means "I selected cells". */
export function captureExcel(node: Node): Capture | null {
  const hit = excelHitOf(node)
  if (hit === null) return null
  const cells = readCells(hit.root)
  if (cells === null) return null
  const anchor: Anchor = { kind: 'cells', sheet: cells.sheet, range: cells.range, ...(cells.cellText === '' ? {} : { cellText: cells.cellText.slice(0, 500) }), ...(cells.formula === undefined ? {} : { formula: cells.formula.slice(0, 500) }) }
  const target: Target = { kind: 'file', path: hit.path, address: hit.address, renderer: 'excel', format: formatOf(hit.path, 'excel') }
  const shown = cells.formula ?? cells.cellText
  // `quote` is what the agent reads as the quoted passage; for cells it is the visible content of the active cell.
  const quote = shown === '' ? `${cells.sheet}!${cells.range}` : shown
  const range = document.createRange()
  range.selectNodeContents(hit.root.querySelector('.fortune-name-box') ?? hit.root)
  return { sessionId: hit.sessionId, target, anchor, quote, find: quote, prefix: '', suffix: '', occurrence: 0, range, viewer: hit.viewer }
}
