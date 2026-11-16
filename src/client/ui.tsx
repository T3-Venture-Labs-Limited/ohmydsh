// Small presentational pieces shared by the page: badges, chips, callouts, copyable code, relative time, run status.
import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Button } from '../kit/index.ts'
import type { RunStatus, SourceKind } from '../shared/types.ts'
import type { T } from './locale.ts'
import { relative, runTone } from './model.ts'
import type { Tone } from './model.ts'

export function Badge({ tone, children, dot = false }: { tone: Tone; children: ReactNode; dot?: boolean }) {
  return <span className="tr-badge" data-tone={tone}>{dot && <span className="tr-badge__dot" aria-hidden="true" />}{children}</span>
}

export function Chip({ children }: { children: ReactNode }) {
  return <span className="tr-chip">{children}</span>
}

export function Callout({ tone, title, children }: { tone: 'warn' | 'error' | 'ok' | 'info'; title?: string; children?: ReactNode }) {
  return (
    <div className="tr-callout" data-tone={tone} role={tone === 'error' ? 'alert' : 'status'}>
      {title !== undefined && <span className="tr-callout__title">{title}</span>}
      {children}
    </div>
  )
}

export function statusLabel(t: T, status: RunStatus): string {
  switch (status) {
    case 'delivered': return t('statusDelivered')
    case 'skipped': return t('statusSkipped')
    case 'failed': return t('statusFailed')
    case 'rejected': return t('statusRejected')
    case 'pending': return t('statusPending')
    case 'queued': return t('statusQueued')
  }
}

export function RunBadge({ t, status }: { t: T; status: RunStatus }) {
  return <Badge tone={runTone(status)} dot>{statusLabel(t, status)}</Badge>
}

export function sourceLabel(t: T, kind: SourceKind): string {
  return kind === 'webhook' ? t('sourceWebhook') : kind === 'file' ? t('sourceFile') : t('sourceComposio')
}

/** Relative time computed at render; the page re-renders on refresh/visibility, so no ticking timer is needed. */
export function timeAgo(t: T, at: number, now = Date.now()): string {
  const r = relative(at, now)
  switch (r.unit) {
    case 'now': return t('timeNow')
    case 'min': return t('timeMin', { n: r.n })
    case 'hour': return t('timeHour', { n: r.n })
    case 'day': return t('timeDay', { n: r.n })
    case 'date': return new Date(at).toLocaleDateString()
  }
}

export function TimeAgo({ t, at }: { t: T; at: number }) {
  return <time dateTime={new Date(at).toISOString()} title={new Date(at).toLocaleString()}>{timeAgo(t, at)}</time>
}

/** Copy button: writes to the clipboard and flips its label to "Copied" briefly. */
export function CopyButton({ t, text, label }: { t: T; text: string; label?: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle')
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => { clearTimeout(timer.current) }, [])
  useEffect(() => { setState('idle') }, [text])
  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text)
      setState('copied')
    } catch {
      setState('failed')
    }
    clearTimeout(timer.current)
    timer.current = setTimeout(() => { setState('idle') }, 1800)
  }
  return (
    <Button variant="outline" size="sm" aria-label={label ?? t('copy')} title={state === 'failed' ? t('copyFailed') : undefined} onClick={() => { void copy() }}>
      {state === 'copied' ? t('copied') : t('copy')}
    </Button>
  )
}

export function CodeLine({ t, text, fresh = false, label }: { t: T; text: string; fresh?: boolean; label?: string }) {
  return (
    <div className="tr-code" data-fresh={fresh || undefined}>
      <pre>{text}</pre>
      <CopyButton t={t} text={text} {...(label === undefined ? {} : { label })} />
    </div>
  )
}
