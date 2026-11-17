import { afterEach, describe, expect, it } from 'vitest'
import { captureExcel, normalizeRange, readCells } from '../src/client/adapters/excel.ts'
import { chipSummary, chipText, locationOf } from '../src/client/format.ts'
import type { ReviewComment } from '../src/client/types.ts'

const ADDRESS = 'dsh-resource://file/session/s1/review-fixtures/q3.xlsx'
function mount(range: string, sheet: string, bar: string): HTMLElement {
  document.body.innerHTML = `<div data-sidebar-right-tab="t"><div data-document-preview="@x/documentpreview/excel" data-textpreview-url="${ADDRESS}">
    <section data-excel-preview>
      <div class="fortune-name-box-container"><div class="fortune-name-box">${range}</div></div>
      <div class="fortune-fx-editor"><div class="fortune-fx-input" contenteditable="false">${bar}</div></div>
      <div class="luckysheet-sheet-area"><div class="luckysheet-sheets-item"><span class="luckysheet-sheets-item-name">Notes</span></div>
        <div class="luckysheet-sheets-item luckysheet-sheets-item-active"><span class="luckysheet-sheets-item-name">${sheet}</span></div></div>
      <canvas class="fortune-sheet-canvas"></canvas>
    </section></div></div>`
  return document.querySelector<HTMLElement>('[data-excel-preview]')!
}
afterEach(() => { document.body.innerHTML = '' })

describe('excel adapter', () => {
  it('normalises ranges', () => {
    expect(normalizeRange('b7')).toBe('B7')
    expect(normalizeRange(' $B$7 : c9 ')).toBe('B7:C9')
    expect(normalizeRange('B7:B7')).toBe('B7')
    expect(normalizeRange('Revenue')).toBeNull()
    expect(normalizeRange('')).toBeNull()
  })
  it('reads the active sheet, range and plain cell text', () => {
    expect(readCells(mount('C7:D9', 'Revenue', '1 204 330'))).toEqual({ sheet: 'Revenue', range: 'C7:D9', cellText: '1 204 330' })
  })
  it('keeps a formula separately from the value', () => {
    expect(readCells(mount('B7', 'Revenue', '=SUM(B2:B5)'))).toEqual({ sheet: 'Revenue', range: 'B7', cellText: '', formula: '=SUM(B2:B5)' })
  })
  it('captures with file identity and a cells anchor', () => {
    const root = mount('B7', 'Revenue', '=SUM(B2:B5)')
    const cap = captureExcel(root.querySelector('canvas')!)!
    expect(cap.target).toMatchObject({ kind: 'file', path: 'review-fixtures/q3.xlsx', renderer: 'excel', format: 'xlsx' })
    expect(cap.anchor).toEqual({ kind: 'cells', sheet: 'Revenue', range: 'B7', formula: '=SUM(B2:B5)' })
    expect(cap.sessionId).toBe('s1')
  })
  it('does nothing when the name box holds no range or the markers are missing', () => {
    const root = mount('', 'Revenue', 'x')
    expect(captureExcel(root.querySelector('canvas')!)).toBeNull()
    document.body.innerHTML = '<div><canvas></canvas></div>'
    expect(captureExcel(document.querySelector('canvas')!)).toBeNull()
  })
})

describe('cell chips', () => {
  const base = (anchor: ReviewComment['anchor'], quote: string): ReviewComment => ({
    id: 'a', number: 4, sessionId: 's1', quote, find: quote, prefix: '', suffix: '', occurrence: 0, body: 'does not match the P&L total', status: 'open', createdAt: 1, updatedAt: 1,
    target: { kind: 'file', path: 'reports/q3.xlsx', address: ADDRESS, renderer: 'excel', format: 'xlsx' }, anchor,
  })
  it('names the sheet and range, and carries the cell content', () => {
    const c = base({ kind: 'cells', sheet: 'Revenue', range: 'C7:D9', cellText: '1 204 330' }, '1 204 330')
    expect(locationOf(c)).toBe('sheet "Revenue", range C7:D9')
    const text = chipText(c)
    expect(text).toContain('File: reports/q3.xlsx')
    expect(text).toContain('Location: sheet "Revenue", range C7:D9')
    expect(text).toContain('Value of the active cell: 1 204 330')
    expect(text).toContain('Comment: does not match the P&L total')
    expect(chipSummary(c).label).toBe('RC-4 q3.xlsx Revenue!C7:D9')
  })
  it('uses the formula when there is one', () => {
    const c = base({ kind: 'cells', sheet: 'Revenue', range: 'B7', formula: '=SUM(B2:B5)' }, '=SUM(B2:B5)')
    expect(locationOf(c)).toBe('sheet "Revenue", cell B7')
    expect(chipText(c)).toContain('Formula of the active cell: =SUM(B2:B5)')
  })
})
