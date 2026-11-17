/**
 * Untrusted HTML/SVG/JavaScript outputs run in an opaque-origin iframe: `sandbox="allow-scripts"` without
 * `allow-same-origin`, so the content cannot reach the DSH page, its cookies or its API; a CSP in the document
 * blocks every network request; there is no navigation, popup or form permission. Height follows the content
 * through postMessage from a tiny reporter script (messages are accepted only from this frame's window).
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { JSX } from 'react'

const CSP = "default-src 'none'; img-src data: blob:; media-src data: blob:; font-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'none'; form-action 'none'; base-uri 'none'"

function documentFor(body: string, token: string, kind: 'html' | 'svg'): string {
  const reporter = `<script>(function(){var t=${JSON.stringify(token)};function h(){var d=document.documentElement;parent.postMessage({nb:t,h:Math.max(d.scrollHeight,document.body?document.body.scrollHeight:0)},'*')}new ResizeObserver(h).observe(document.documentElement);addEventListener('load',h);h()})()</script>`
  const content = kind === 'svg' ? `<div style="display:flex;justify-content:center">${body}</div>` : body
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${CSP}"><meta name="color-scheme" content="light dark"><style>html,body{margin:0;padding:0;font:13px system-ui,sans-serif;overflow-y:hidden}img,svg{max-width:100%;height:auto}table{border-collapse:collapse}</style></head><body>${content}${reporter}</body></html>`
}

export function SandboxFrame({ body, kind, title, maxHeight = 640 }: { body: string; kind: 'html' | 'svg'; title: string; maxHeight?: number }): JSX.Element {
  const ref = useRef<HTMLIFrameElement>(null)
  const token = useMemo(() => Math.random().toString(36).slice(2), [])
  const [height, setHeight] = useState(60)
  const srcDoc = useMemo(() => documentFor(body, token, kind), [body, token, kind])
  useEffect(() => {
    const onMessage = (event: MessageEvent): void => {
      if (event.source !== ref.current?.contentWindow) return
      const data = event.data as { nb?: unknown; h?: unknown } | null
      if (data === null || typeof data !== 'object' || data.nb !== token || typeof data.h !== 'number') return
      setHeight(Math.min(maxHeight, Math.max(24, Math.ceil(data.h) + 2)))
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [token, maxHeight])
  return <iframe ref={ref} className="nb-frame" title={title} sandbox="allow-scripts" referrerPolicy="no-referrer" srcDoc={srcDoc} style={{ height }} />
}
