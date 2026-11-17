/** Rich output rendering. Untrusted content goes through sandboxed frames or <img> only, never into the host DOM. */
import { useMemo, useState } from 'react'
import type { JSX } from 'react'
import { Button } from '../kit/index.ts'
import type { JsonObject } from '../core/types.ts'
import { parseAnsi } from './ansi.ts'
import { SandboxFrame } from './frame.tsx'
import { Latex } from './math.tsx'
import type { T } from './locale.ts'
import { renderMarkdown } from './markdown.ts'
import { MarkdownView } from './markdown-view.tsx'

const asText = (v: unknown): string => (Array.isArray(v) ? v.join('') : typeof v === 'string' ? v : '')
const MAX_LINES = 40

function Ansi({ text }: { text: string }): JSX.Element {
  const spans = useMemo(() => parseAnsi(text), [text])
  return <>{spans.map((span, i) => (span.classes.length === 0 ? span.text : <span key={i} className={span.classes.map((c) => `nb-ansi--${c}`).join(' ')}>{span.text}</span>))}</>
}

/** Long text is folded to a window with a toggle; the full text stays in the notebook. */
function Folded({ text, className, t }: { text: string; className: string; t: T }): JSX.Element {
  const [open, setOpen] = useState(false)
  const lines = useMemo(() => text.split('\n'), [text])
  const long = lines.length > MAX_LINES
  const shown = long && !open ? [...lines.slice(0, 12), '…', ...lines.slice(-(MAX_LINES - 13))].join('\n') : text
  return (
    <>
      <pre className={className}><Ansi text={shown} /></pre>
      {long && <div className="nb-out__more"><Button size="sm" variant="ghost" onClick={() => setOpen(!open)}>{open ? t('showLess') : t('showMore', { count: lines.length })}</Button></div>}
    </>
  )
}

const dataUrl = (mime: string, value: string): string => (value.startsWith('data:') ? value : `data:${mime};base64,${value.replace(/\s+/g, '')}`)
const SKIP = new Set(['text/plain', 'text/html', 'text/markdown', 'text/latex', 'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml', 'application/json', 'application/javascript', 'application/vnd.plotly.v1+json'])

function plotlyDocument(spec: unknown): string | null {
  // Plotly's own bundle is not shipped: an offline figure cannot draw without it. Show data summary instead of fetching code.
  void spec
  return null
}

export function Output({ output, t }: { output: JsonObject; t: T }): JSX.Element | null {
  switch (output.output_type) {
    case 'stream':
      return <Folded text={asText(output.text)} className={`nb-out${output.name === 'stderr' ? ' nb-out--stderr' : ''}`} t={t} />
    case 'error': {
      const trace = (Array.isArray(output.traceback) ? output.traceback : []).map(String).join('\n')
      return <Folded text={trace !== '' ? trace : `${String(output.ename)}: ${String(output.evalue)}`} className="nb-out nb-out--error" t={t} />
    }
    case 'execute_result':
    case 'display_data': {
      const data = (typeof output.data === 'object' && output.data !== null ? output.data : {}) as JsonObject
      const result = output.output_type === 'execute_result' ? ' nb-out--result' : ''
      for (const mime of ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const) {
        const value = data[mime]
        if (typeof value === 'string') return <img className="nb-img" alt={t('imageAlt')} src={dataUrl(mime, value)} />
      }
      const svg = asText(data['image/svg+xml'])
      if (svg !== '') return <SandboxFrame body={svg} kind="svg" title={t('svgOutput')} />
      const html = asText(data['text/html'])
      if (html !== '') return <SandboxFrame body={html} kind="html" title={t('htmlOutput')} />
      const js = asText(data['application/javascript'])
      if (js !== '') return <SandboxFrame body={`<script>${js.replace(/<\/script/gi, '<\\/script')}</script>`} kind="html" title={t('jsOutput')} />
      const latex = asText(data['text/latex'])
      if (latex !== '') return <Latex tex={latex} />
      const md = asText(data['text/markdown'])
      if (md !== '') return <MarkdownView html={renderMarkdown(md)} className="nb-md" />
      if (data['application/json'] !== undefined) return <pre className="nb-out nb-json">{JSON.stringify(data['application/json'], null, 2)}</pre>
      const plain = asText(data['text/plain'])
      if (plain !== '') return <Folded text={plain} className={`nb-out${result}`} t={t} />
      const others = Object.keys(data).filter((k) => !SKIP.has(k))
      if (data['application/vnd.plotly.v1+json'] !== undefined) {
        void plotlyDocument
        return <div className="nb-note">{t('plotlyOutput')}: {t('unsupportedOutput', { types: 'application/vnd.plotly.v1+json' })}</div>
      }
      return others.length > 0 ? <div className="nb-note">{t('unsupportedOutput', { types: others.join(', ') })}</div> : null
    }
    default:
      return null
  }
}
