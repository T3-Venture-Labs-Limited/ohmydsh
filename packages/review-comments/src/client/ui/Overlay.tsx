// Frame-wide floating layer (shell.overlay): the Comment toolbar, the comment popover, highlight painting and notices.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { KeyboardEvent as ReactKeyboard } from 'react'
import { Button, IconButton } from '../../kit/index.ts'
import type { Ctx } from '../host.ts'
import type { SelectionController } from '../selection.ts'
import type { CommentStore } from '../store.ts'
import type { Capture } from '../types.ts'
import { t } from '../locale.ts'
import { uiState } from '../ui-state.ts'
import { mergeRects } from '../adapters/documents.ts'
import { currentSessionId } from '../host.ts'
import { paintHighlights, resolveComments, type Resolved } from '../highlights.ts'
import { IconComment } from './icons.tsx'
import { useDrcStyles } from './styles.ts'
import { useVersion } from './hooks.ts'

interface Box { left: number; top: number; right: number; bottom: number }

function endOfSelection(range: Range): Box | null {
  const rects = mergeRects([...range.getClientRects()])
  const last = rects[rects.length - 1]
  return last ?? null
}

function viewerClip(viewer: HTMLElement): Box {
  const r = viewer.getBoundingClientRect()
  const composer = viewer.closest('[data-conversation-session]')?.querySelector<HTMLElement>('[data-composer-seat]')?.getBoundingClientRect()
  const bottom = composer !== undefined && composer.width > 0 && composer.top > r.top ? Math.min(r.bottom, composer.top) : r.bottom
  return { left: Math.max(0, r.left), top: Math.max(0, r.top), right: Math.min(window.innerWidth, r.right), bottom: Math.min(window.innerHeight, bottom) }
}

function place(anchor: Box, clip: Box, width: number, height: number): { left: number; top: number } | null {
  if (anchor.bottom < clip.top || anchor.top > clip.bottom) return null
  const left = Math.max(clip.left + 8, Math.min(anchor.right - width + 6, clip.right - width - 8))
  const below = anchor.bottom + 8
  const top = below + height <= clip.bottom - 4 ? below : Math.max(clip.top + 4, anchor.top - height - 8)
  return { left, top }
}

function Popover({ capture, onSave, onCancel, error }: { capture: Capture; onSave(body: string): void; onCancel(): void; error: string }) {
  const [body, setBody] = useState('')
  const area = useRef<HTMLTextAreaElement>(null)
  useEffect(() => { area.current?.focus() }, [])
  const key = (event: ReactKeyboard<HTMLTextAreaElement>): void => {
    event.stopPropagation()
    if (event.key === 'Escape') { event.preventDefault(); onCancel() }
    else if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); onSave(body) }
  }
  const preview = capture.quote.length > 400 ? `${capture.quote.slice(0, 400)}…` : capture.quote
  return (
    <div className="drc-popover" role="dialog" aria-label={t('popoverTitle')} data-drc-ui>
      <p className="drc-popover__title">{t('quoteLabel')}</p>
      <blockquote className="drc-quote">{preview}</blockquote>
      <textarea ref={area} className="drc-textarea" aria-label={t('popoverTitle')} placeholder={t('popoverPlaceholder')} value={body}
        onChange={event => { setBody(event.target.value) }} onKeyDown={key} />
      {error !== '' && <p className="drc-popover__hint" role="alert" style={{ color: 'var(--dsw-alias-state-error-primary)' }}>{error}</p>}
      <p className="drc-popover__hint">{t('popoverHint')}</p>
      <div className="drc-popover__actions">
        <Button size="sm" variant="ghost" onClick={onCancel}>{t('cancel')}</Button>
        <Button size="sm" variant="primary" onClick={() => { onSave(body) }}>{t('save')}</Button>
      </div>
    </div>
  )
}

export function Overlay({ ctx, controller, store }: { ctx: Ctx; controller: SelectionController; store: CommentStore }) {
  useDrcStyles()
  const capture = useSyncExternalStore(controller.subscribe, controller.getSnapshot)
  const version = useVersion(store.subscribe, store.getSnapshot)
  const notice = useSyncExternalStore(uiState.subscribe, uiState.notice)
  const active = useSyncExternalStore(uiState.subscribe, uiState.active)
  const [editing, setEditing] = useState<Capture | null>(null)
  const [error, setError] = useState('')
  const [tick, setTick] = useState(0)
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)
  const floatRef = useRef<HTMLDivElement>(null)
  const shown = editing ?? capture
  const sessionId = currentSessionId(ctx)

  // A different selection while the popover is open abandons it only when it moves to another place deliberately.
  useEffect(() => {
    if (editing === null) return
    const onKey = (event: KeyboardEvent): void => { if (event.key === 'Escape') { setEditing(null); controller.hold(false) } }
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('keydown', onKey) }
  }, [editing, controller])

  const closeEditor = useCallback((): void => { setEditing(null); setError(''); controller.hold(false); controller.clear() }, [controller])

  const save = useCallback(async (body: string): Promise<void> => {
    if (editing === null) return
    try {
      const anchor = editing.resolveAnchor ? await editing.resolveAnchor() : editing.anchor
      store.add({ sessionId: editing.sessionId, target: editing.target, anchor, quote: editing.quote, find: editing.find, prefix: editing.prefix, suffix: editing.suffix, occurrence: editing.occurrence, body: body.trim() })
      closeEditor()
    } catch (reason) {
      setError(t('saveFailed', { reason: reason instanceof Error ? reason.message : String(reason) }))
    }
  }, [editing, store, closeEditor])

  // Position the floating element beside the end of the selection, clipped to its viewer and composer.
  useLayoutEffect(() => {
    if (shown === null) { setPos(null); return }
    const el = floatRef.current
    const update = (): void => {
      const range = shown.range
      if (!range.startContainer.isConnected || el === null) { setPos(null); return }
      const end = endOfSelection(range)
      if (end === null) { setPos(null); return }
      const { width, height } = el.getBoundingClientRect()
      setPos(place(end, viewerClip(shown.viewer), width || 40, height || 32))
    }
    update()
    let frame = 0
    const schedule = (): void => { if (frame === 0) frame = requestAnimationFrame(() => { frame = 0; update() }) }
    window.addEventListener('resize', schedule)
    window.addEventListener('scroll', schedule, true)
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(schedule)
    observer?.observe(shown.viewer)
    if (el !== null) observer?.observe(el)
    return () => { window.removeEventListener('resize', schedule); window.removeEventListener('scroll', schedule, true); observer?.disconnect(); if (frame !== 0) cancelAnimationFrame(frame) }
  }, [shown, editing === null])

  // Pending selection stays visible while the popover has focus.
  useEffect(() => {
    const registry = (globalThis.CSS as unknown as { highlights?: { set(n: string, h: unknown): void; delete(n: string): void } } | undefined)?.highlights
    const Ctor = (globalThis as unknown as { Highlight?: new (...r: Range[]) => unknown }).Highlight
    if (registry === undefined || Ctor === undefined) return
    if (editing === null) { registry.delete('drc-pending'); return }
    registry.set('drc-pending', new Ctor(editing.range))
    return () => { registry.delete('drc-pending') }
  }, [editing])

  // Highlights and PDF boxes for comments that are still open or sent. Re-resolved on store change, layout change and DOM churn.
  const [resolved, setResolved] = useState<Resolved | null>(null)
  const relevant = useMemo(() => store.list(sessionId).filter(item => item.status !== 'resolved'), [store, sessionId, version])
  useEffect(() => {
    if (relevant.length === 0) { setResolved(null); return }
    let frame = 0
    const run = (): void => { frame = 0; if (!document.hidden) setResolved(resolveComments(relevant)) }
    const schedule = (): void => { if (frame === 0) frame = requestAnimationFrame(run) }
    run()
    window.addEventListener('resize', schedule)
    window.addEventListener('scroll', schedule, true)
    const observer = new MutationObserver(schedule)
    observer.observe(document.body, { childList: true, subtree: true, characterData: true })
    document.addEventListener('visibilitychange', schedule)
    return () => {
      window.removeEventListener('resize', schedule); window.removeEventListener('scroll', schedule, true)
      document.removeEventListener('visibilitychange', schedule); observer.disconnect()
      if (frame !== 0) cancelAnimationFrame(frame)
    }
  }, [relevant, tick])
  useEffect(() => { if (resolved === null) return paintHighlights({ ranges: new Map(), boxes: [], anchors: new Map() }, null); return paintHighlights(resolved, active) }, [resolved, active])
  useEffect(() => { void tick }, [tick])
  useEffect(() => { const off = uiState.subscribe(() => { setTick(n => n + 1) }); return off }, [])

  const toolbarDisabled = sessionId === '' && shown?.sessionId === ''
  return (
    <div className="drc-layer" data-drc-ui>
      {resolved?.boxes.map((box, i) => {
        const left = Math.max(box.left, box.clip.left)
        const top = Math.max(box.top, box.clip.top)
        const right = Math.min(box.left + box.width, box.clip.right)
        const bottom = Math.min(box.top + box.height, box.clip.bottom)
        if (right <= left || bottom <= top) return null
        return <div key={`${box.id}-${i}`} className="drc-box" data-active={box.id === active || undefined} style={{ left, top, width: right - left, height: bottom - top }} />
      })}
      {shown !== null && !toolbarDisabled && (
        <div ref={floatRef} className="drc-float" style={pos === null ? { visibility: 'hidden', left: 0, top: 0 } : { left: pos.left, top: pos.top }} data-drc-ui
          onPointerDown={event => { if (editing === null) event.preventDefault() }}>
          {editing === null
            ? <div className="drc-toolbar" role="toolbar" aria-label={t('toolbarLabel')}>
                <Button size="sm" variant="ghost" icon={<IconComment />} title={t('commentTitle')}
                  onClick={() => { setError(''); controller.hold(true); setEditing(shown) }}>{t('comment')}</Button>
              </div>
            : <Popover capture={editing} error={error} onCancel={closeEditor} onSave={body => { void save(body) }} />}
        </div>
      )}
      {notice !== null && <div className="drc-notice" role="status" data-tone={notice.tone}>{notice.text}</div>}
    </div>
  )
}

export { IconButton }
