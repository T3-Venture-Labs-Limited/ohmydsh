import { useEffect, useRef } from 'react'
import type { JSX } from 'react'
import { upgradeMath } from './math.tsx'

/** Markdown HTML from our escaping renderer; `$math$` placeholders are upgraded with KaTeX after mount. */
export function MarkdownView({ html, className, onDoubleClick }: { html: string; className?: string; onDoubleClick?: () => void }): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => { if (ref.current !== null) upgradeMath(ref.current) }, [html])
  return <div ref={ref} className={className} onDoubleClick={onDoubleClick} dangerouslySetInnerHTML={{ __html: html }} />
}
