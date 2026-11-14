// The per-message "Open trace" button (lazy chunk). Hidden while tracing is off; the link is resolved on click.
import { useEffect, useState } from 'react'
import { IconButton, Tooltip, useKitStyles } from '../kit/index.ts'
import type { Face, TraceStatus } from './trace-link.ts'
import type { T } from './locale.ts'

/** Only http(s) URLs may be opened; the Host builds them but the browser still verifies. */
function safeUrl(url: string | undefined): string | undefined {
  if (url === undefined) return undefined
  try {
    const u = new URL(url)
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : undefined
  } catch {
    return undefined
  }
}

/** One status read shared by every button in the transcript. */
let shared: { face: Face; promise: Promise<TraceStatus | null> } | undefined
function status(face: Face): Promise<TraceStatus | null> {
  if (shared === undefined || shared.face !== face) shared = { face, promise: face.status() }
  return shared.promise
}

function Glyph() {
  return (
    <svg width={15} height={15} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="3.5" cy="4" r="1.6" />
      <circle cx="12.5" cy="8" r="1.6" />
      <circle cx="3.5" cy="12" r="1.6" />
      <path d="M5 4.3 11 7.6M5 11.7 11 8.4" />
    </svg>
  )
}

export default function OpenTraceAction({ messageId, sessionId, face, t }: { messageId: string; sessionId: string; face: Face; t: T }) {
  useKitStyles()
  const [enabled, setEnabled] = useState<boolean | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  useEffect(() => {
    let alive = true
    void status(face).then((s) => { if (alive) setEnabled(s?.enabled === true) })
    return () => { alive = false }
  }, [face])
  if (enabled !== true || sessionId === '') return null

  const open = (): void => {
    if (busy) return
    setBusy(true)
    setFailure(null)
    // Open the tab synchronously (popup blockers), then point it at the trace once the Host answers.
    const tab = window.open('', '_blank')
    void face.traceFor(sessionId, messageId).then((link) => {
      const url = link?.ok === true ? safeUrl(link.url) : undefined
      if (url === undefined) {
        tab?.close()
        setFailure(t('openTraceFailed', { reason: link?.reason ?? '' }))
        return
      }
      if (tab !== null) { tab.opener = null; tab.location.href = url } else window.open(url, '_blank', 'noopener')
    }).finally(() => { setBusy(false) })
  }

  return (
    <>
      <Tooltip label={failure ?? (busy ? t('openTraceBusy') : t('openTrace'))} side="bottom">
        <IconButton label={t('openTrace')} icon={<Glyph />} disabled={busy} onClick={open} />
      </Tooltip>
      {failure === null ? null : <span role="status" style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden' }}>{failure}</span>}
    </>
  )
}
