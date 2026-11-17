// Ref-counted stylesheet injection (same pattern as the kit): the page's CSS exists only while the page is mounted.
import { useEffect } from 'react'
import css from './studio.css?inline'

let mounted = 0
let tag: HTMLStyleElement | null = null

export function useStudioStyles(): void {
  useEffect(() => {
    if (mounted++ === 0) {
      tag = document.createElement('style')
      tag.dataset.ssStyles = ''
      tag.textContent = css
      document.head.appendChild(tag)
    }
    return () => {
      if (--mounted === 0) { tag?.remove(); tag = null }
    }
  }, [])
}
