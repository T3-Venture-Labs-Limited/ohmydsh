// Modal keyboard ownership: only the top modal handles Escape and Tab, focus is trapped, and the previous focus
// is restored on close (behaviour copied from the DSH primitives' useModalLayer, without the shell-specific parts).
// The listener runs in the capture phase so the top kit modal owns Escape even above a host dialog.
import { useLayoutEffect, useRef } from 'react'
import type { RefObject } from 'react'

const layers: HTMLElement[] = []
const focusable = 'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), a[href], [tabindex="0"]'

export function useModalLayer(dialog: RefObject<HTMLElement | null>, open: boolean, onClose: () => void): void {
  const close = useRef(onClose)
  close.current = onClose
  useLayoutEffect(() => {
    const element = dialog.current
    if (!open || element === null) return
    const doc = element.ownerDocument
    const previous = doc.activeElement
    layers.push(element)
    const initial = element.querySelector<HTMLElement>('[data-modal-autofocus]') ?? element.querySelector<HTMLElement>(focusable) ?? element
    if (!element.contains(doc.activeElement)) initial.focus()
    const keydown = (event: KeyboardEvent): void => {
      if (layers[layers.length - 1] !== element || event.defaultPrevented || event.isComposing) return
      if (event.ctrlKey || event.altKey || event.metaKey) return
      if (event.key === 'Escape' && !event.shiftKey) {
        // Capture phase + stopPropagation: a host dialog underneath (e.g. Settings) must not also close on this Escape.
        event.preventDefault()
        event.stopPropagation()
        if (!event.repeat) close.current()
        return
      }
      if (event.key !== 'Tab') return
      const items = [...element.querySelectorAll<HTMLElement>(focusable)].filter((item) => !item.closest('[inert], [hidden]'))
      const first = items[0] ?? element
      const last = items[items.length - 1] ?? element
      const active = doc.activeElement
      const atEdge = event.shiftKey ? active === first : active === last
      if (active === element || !element.contains(active) || atEdge) {
        event.preventDefault()
        ;(event.shiftKey ? last : first).focus()
      }
    }
    doc.addEventListener('keydown', keydown, true)
    return () => {
      doc.removeEventListener('keydown', keydown, true)
      const wasTop = layers[layers.length - 1] === element
      layers.splice(layers.indexOf(element), 1)
      if (wasTop && previous instanceof HTMLElement && previous.isConnected) previous.focus()
    }
  }, [dialog, open])
}
