// The ohmydsh mark and wordmark as React. Both paint with theme tokens, so they follow light/dark and any theme layer
// (Omarchy, endfield): the mark takes the brand colour, the wordmark the surrounding text colour (currentColor).
import { MARK_PATH, MARK_TRANSFORM, MARK_VIEWBOX, WORDMARK_PATH, WORDMARK_VIEWBOX } from '../artwork/paths.ts'

export function BrandMark({ size, className }: { size: number; className?: string | undefined }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox={MARK_VIEWBOX}
      fill="none"
      aria-hidden="true"
      focusable="false"
      data-ohmydsh-mark=""
      className={className}
      style={{ display: 'block', flex: 'none', color: 'var(--dsw-alias-brand-primary, currentColor)' }}
    >
      <path fill="currentColor" fillRule="evenodd" transform={MARK_TRANSFORM} d={MARK_PATH} />
    </svg>
  )
}

const WORD_VIEWBOX = WORDMARK_VIEWBOX.split(' ').map(Number)
/** Wordmark height in px; width follows the artwork's aspect ratio so the sidebar row never shifts. */
export const WORDMARK_HEIGHT = 16

export function BrandWordmark({ title }: { title?: string | undefined }) {
  const w = Math.round(((WORD_VIEWBOX[2] ?? 1) / (WORD_VIEWBOX[3] ?? 1)) * WORDMARK_HEIGHT * 100) / 100
  return (
    <span data-ohmydsh-name="" title={title} style={{ display: 'inline-flex', alignItems: 'center', color: 'var(--dsw-alias-label-primary, currentColor)' }}>
      <svg width={w} height={WORDMARK_HEIGHT} viewBox={WORDMARK_VIEWBOX} fill="none" role="img" aria-label="ohmydsh" focusable="false">
        <path fill="currentColor" d={WORDMARK_PATH} />
      </svg>
    </span>
  )
}
