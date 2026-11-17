// Ref-counted plugin stylesheet (kit pattern): present only while one of our surfaces is mounted.
import { useEffect } from 'react'
import css from './drc.css?inline'
import { useKitStyles } from '../../kit/index.ts'

let mounted = 0
let tag: HTMLStyleElement | null = null

export function useDrcStyles(): void {
  useKitStyles()
  useEffect(() => {
    if (mounted++ === 0) {
      tag = document.createElement('style')
      tag.dataset.drcStyles = ''
      tag.textContent = css
      document.head.appendChild(tag)
    }
    return () => {
      if (--mounted === 0) { tag?.remove(); tag = null }
    }
  }, [])
}
