// Ref-counted stylesheet injection: the first mounted kit component appends one <style data-dk-styles> to <head>,
// the last unmount removes it, so disabling a plugin leaves no CSS behind.
import { useEffect } from 'react'
import kitCss from './kit.css?inline'

let mounted = 0
let tag: HTMLStyleElement | null = null

/** Call once at the root of every kit-using surface (Page, Modal and Tooltip already do). */
export function useKitStyles(): void {
  useEffect(() => {
    if (mounted++ === 0) {
      tag = document.createElement('style')
      tag.dataset.dkStyles = ''
      tag.textContent = kitCss
      document.head.appendChild(tag)
    }
    return () => {
      if (--mounted === 0) {
        tag?.remove()
        tag = null
      }
    }
  }, [])
}
