/** LaTeX rendering with KaTeX, output as MathML (native in the browser, so no stylesheet or fonts to ship). Loaded lazily. */
import { useEffect, useState } from 'react'
import type { JSX } from 'react'

type Katex = { renderToString: (tex: string, options: Record<string, unknown>) => string }
let katexPromise: Promise<Katex> | undefined

export function loadKatex(): Promise<Katex> {
  katexPromise ??= import('katex').then((m) => (m as unknown as { default: Katex }).default ?? (m as unknown as Katex))
  return katexPromise
}

export async function renderTex(tex: string, display: boolean): Promise<string> {
  const katex = await loadKatex()
  return katex.renderToString(tex, { output: 'mathml', displayMode: display, throwOnError: false, trust: false, strict: 'ignore', maxSize: 20, maxExpand: 500 })
}

/** Display a LaTeX string (text/latex output). `$$…$$` delimiters are optional. */
export function Latex({ tex }: { tex: string }): JSX.Element {
  const [html, setHtml] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    const stripped = tex.trim().replace(/^\$\$([\s\S]*)\$\$$/, '$1').replace(/^\$([\s\S]*)\$$/, '$1').replace(/^\\\[([\s\S]*)\\\]$/, '$1')
    void renderTex(stripped, true).then((out) => { if (live) setHtml(out) }, () => { if (live) setHtml(null) })
    return () => { live = false }
  }, [tex])
  return html === null ? <pre className="nb-out">{tex}</pre> : <div className="nb-out nb-math-display" dangerouslySetInnerHTML={{ __html: html }} />
}

/** Upgrade the `.nb-math` placeholders the markdown renderer emits inside `root`. */
export function upgradeMath(root: HTMLElement): void {
  const nodes = [...root.querySelectorAll<HTMLElement>('.nb-math[data-tex]')]
  if (nodes.length === 0) return
  void Promise.all(nodes.map(async (node) => {
    try {
      node.innerHTML = await renderTex(node.dataset.tex ?? '', node.classList.contains('nb-math-display'))
    } catch { /* keep the escaped source */ }
  }))
}
