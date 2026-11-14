// Jump from the Review tab to a comment's place: open the file (or find the reply) and scroll the text into view.
import type { Ctx } from './host.ts'
import { sidebarRightOf } from './host.ts'
import type { ReviewComment } from './types.ts'
import { chatBodiesFor } from './adapters/chat.ts'
import { PREVIEW } from './adapters/documents.ts'
import { bsBodiesFor } from './adapters/bettersidebar.ts'
import { resolveComments } from './highlights.ts'
import { uiState } from './ui-state.ts'
import { t } from './locale.ts'

function waitFor<T>(find: () => T | null, ms = 4000): Promise<T | null> {
  return new Promise(resolve => {
    const start = performance.now()
    const tick = (): void => {
      const found = find()
      if (found !== null) { resolve(found); return }
      if (performance.now() - start > ms || document.hidden) { resolve(null); return }
      requestAnimationFrame(tick)
    }
    tick()
  })
}

function scrollIntoPort(el: Element, block: ScrollLogicalPosition = 'center'): void {
  el.scrollIntoView({ block, inline: 'nearest', behavior: 'smooth' })
}

export async function reveal(ctx: Ctx, comment: ReviewComment): Promise<boolean> {
  if (comment.target.kind === 'message') {
    const body = await waitFor(() => chatBodiesFor(comment)[0] ?? null, 600)
    if (body === null) { uiState.notify(t('jumpMissing'), 'error'); return false }
    scrollIntoPort(body, 'start')
    uiState.setActive(comment.id)
    return true
  }
  const address = comment.target.address
  const sidebar = sidebarRightOf(ctx)
  const lineParam = comment.anchor.kind === 'lines' && comment.anchor.hint !== 'none' && comment.anchor.start > 0 ? { line: comment.anchor.start } : undefined
  try {
    const options = lineParam === undefined ? undefined : { params: lineParam }
    if (sidebar?.openResourceIn !== undefined) sidebar.openResourceIn(comment.sessionId, address, options)
    else sidebar?.openResource?.(address, options)
  } catch (error) { console.warn('[dsh-review-comments] open failed', error) }

  const isBs = comment.target.renderer === 'bs-code' || comment.target.renderer === 'bs-markdown'
  const preview = isBs
    ? await waitFor(() => bsBodiesFor(address)[0]?.host ?? null)
    : await waitFor(() => [...document.querySelectorAll<HTMLElement>(PREVIEW)].find(el => el.dataset.textpreviewUrl === address) ?? null)
  if (preview === null) { uiState.notify(t('jumpMissing'), 'error'); return false }
  if (comment.anchor.kind === 'cells') {
    // The grid is a canvas: opening the right file is all we can do. Say where to look.
    uiState.notify(t('jumpCells', { sheet: comment.anchor.sheet, range: comment.anchor.range }))
    return true
  }
  if (comment.anchor.kind === 'pdf') {
    const page = await waitFor(() => preview.querySelector<HTMLElement>(`[data-pdf-page="${(comment.anchor as { page: number }).page}"]`))
    if (page === null) { uiState.notify(t('jumpMissing'), 'error'); return false }
    // Pages render lazily and change height as they do, so aim at the first commented line, then re-aim until it stops moving.
    const rect = comment.anchor.rects[0]
    const port = page.closest<HTMLElement>('[data-document-zoom-scrollport]') ?? page.parentElement
    if (port === null || rect === undefined) scrollIntoPort(page, 'start')
    else {
      const aim = (): number => {
        const r = page.getBoundingClientRect()
        const offset = r.top - port.getBoundingClientRect().top + rect.y * r.height - 60
        if (Math.abs(offset) > 2) port.scrollTop += offset
        return offset
      }
      aim()
      for (let i = 0; i < 6; i += 1) {
        await new Promise<void>(resolve => { setTimeout(resolve, 120) })
        if (Math.abs(aim()) <= 2) break
      }
    }
    uiState.setActive(comment.id)
    return true
  }
  const range = await waitFor(() => resolveComments([comment]).ranges.get(comment.id)?.[0] ?? null, 2500)
  if (range === null) {
    uiState.notify(t('jumpMissing'), 'error')
    return false
  }
  const el = range.startContainer.parentElement
  if (el !== null) scrollIntoPort(el)
  uiState.setActive(comment.id)
  return true
}
