// Tooltip: hover/focus bubble, portaled to <body>, placed from measured boxes with side flipping.
// Focus after a pointer interaction (a closing menu refocusing its trigger) never raises it; click dismisses it.
import { cloneElement, useCallback, useEffect, useRef, useState } from 'react'
import type { FocusEventHandler, PointerEventHandler, ReactElement, MouseEventHandler, Ref } from 'react'
import { createPortal } from 'react-dom'
import { placeTooltip } from './tooltip-placement.ts'
import type { TooltipSide } from './tooltip-placement.ts'
import { pointerModality, trackInputModality } from './input-modality.ts'
import { useKitStyles } from './styles.ts'

export type { TooltipSide } from './tooltip-placement.ts'

interface AnchorProps {
  ref?: Ref<HTMLElement> | undefined
  onPointerEnter?: PointerEventHandler | undefined
  onPointerLeave?: PointerEventHandler | undefined
  onClick?: MouseEventHandler | undefined
  onFocus?: FocusEventHandler | undefined
  onBlur?: FocusEventHandler | undefined
  'aria-describedby'?: string | undefined
}

export interface TooltipProps {
  label: string
  side?: TooltipSide
  align?: 'center' | 'end'
  /** Hover delay in ms (default 300). */
  delayMs?: number
  gap?: number
  disabled?: boolean
  /** Exactly one anchor element; its own ref and handlers are preserved. */
  children: ReactElement<AnchorProps>
}

export function Tooltip({ label, side = 'bottom', align = 'center', delayMs = 300, gap = 8, disabled = false, children }: TooltipProps) {
  useKitStyles()
  const anchor = useRef<HTMLElement | null>(null)
  const bubble = useRef<HTMLSpanElement | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const triggers = useRef({ hover: false, focus: false })
  const [rect, setRect] = useState<DOMRect | null>(null)
  const id = useRef(`dk-tip-${Math.random().toString(36).slice(2, 9)}`).current
  const childRef = (children as ReactElement<AnchorProps> & { ref?: Ref<HTMLElement> }).ref
  const mergedRef = useCallback((el: HTMLElement | null) => {
    anchor.current = el
    if (typeof childRef === 'function') childRef(el)
    else if (childRef != null) (childRef as { current: HTMLElement | null }).current = el
  }, [childRef])

  useEffect(() => trackInputModality(), [])

  const cancel = useCallback(() => {
    if (timer.current !== null) clearTimeout(timer.current)
    timer.current = null
  }, [])
  const withdraw = useCallback(() => { cancel(); setRect(null) }, [cancel])
  const show = useCallback(() => {
    if (!disabled && anchor.current !== null) setRect(anchor.current.getBoundingClientRect())
  }, [disabled])
  const showAfter = useCallback((delay: number) => {
    cancel()
    if (delay <= 0) show()
    else timer.current = setTimeout(() => { timer.current = null; show() }, delay)
  }, [cancel, show])

  useEffect(() => {
    if (disabled) { triggers.current = { hover: false, focus: false }; withdraw() }
    return cancel
  }, [disabled, withdraw, cancel])

  const visible = rect !== null && !disabled
  useEffect(() => {
    const el = bubble.current
    if (!visible || el === null || rect === null) return
    const fit = (size: { inlineSize: number; blockSize: number }, anchorRect: DOMRect | typeof rect): void => {
      const p = placeTooltip({
        anchor: anchorRect, width: size.inlineSize, height: size.blockSize,
        viewportWidth: window.innerWidth, viewportHeight: window.innerHeight, side, align, gap,
      })
      const horizontal = p.side === 'right' || p.side === 'left'
      el.style.left = `${p.left + (horizontal ? 0 : align === 'end' ? p.width : p.width / 2)}px`
      el.style.top = `${p.top + (horizontal ? p.height / 2 : p.side === 'top' ? p.height : 0)}px`
      el.dataset.side = p.side
      el.style.visibility = 'visible'
    }
    let size = { inlineSize: el.offsetWidth, blockSize: el.offsetHeight }
    let anchorRect: DOMRect = rect
    fit(size, anchorRect)
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver((entries) => {
      const box = entries[0]?.borderBoxSize[0]
      if (box !== undefined) { size = box; fit(size, anchorRect) }
    })
    observer?.observe(el, { box: 'border-box' })
    const onResize = (): void => {
      if (anchor.current !== null) anchorRect = anchor.current.getBoundingClientRect()
      fit(size, anchorRect)
    }
    window.addEventListener('resize', onResize)
    return () => { observer?.disconnect(); window.removeEventListener('resize', onResize) }
  }, [visible, rect, side, align, gap])

  const bubbleNode = visible && (
    <span ref={bubble} id={id} role="tooltip" className="dk-tooltip" data-side={side} data-align={align} style={{ left: rect.left, top: rect.top, visibility: 'hidden' }}>
      {label}
    </span>
  )

  return (
    <>
      {cloneElement(children, {
        ref: mergedRef,
        'aria-describedby': visible ? [children.props['aria-describedby'], id].filter(Boolean).join(' ') : children.props['aria-describedby'],
        onPointerEnter: (e) => {
          children.props.onPointerEnter?.(e)
          if (e.pointerType === 'touch') return
          triggers.current.hover = true
          showAfter(delayMs)
        },
        onPointerLeave: (e) => {
          children.props.onPointerLeave?.(e)
          triggers.current.hover = false
          withdraw()
        },
        onClick: (e) => {
          children.props.onClick?.(e)
          triggers.current.focus = false
          withdraw()
        },
        onFocus: (e) => {
          children.props.onFocus?.(e)
          if (pointerModality()) return
          triggers.current.focus = true
          showAfter(0)
        },
        onBlur: (e) => {
          children.props.onBlur?.(e)
          triggers.current.focus = false
          if (!triggers.current.hover) withdraw()
        },
      })}
      {bubbleNode !== false && createPortal(bubbleNode, document.body)}
    </>
  )
}
