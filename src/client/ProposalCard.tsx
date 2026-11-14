import { useMemo, useState } from 'react'
import { Button } from '../kit/index.ts'
import { ApiError, call, type Issue, type Proposal } from './api.ts'
import { Badge } from './Row.tsx'
import { relativeTime } from './helpers.ts'
import type { T } from './locale.ts'

function DiffView({ diff }: { diff: string }) {
  return (
    <pre className="ss-diff ss-mono" aria-label="diff">
      {diff.split('\n').map((line, i) => (
        <span key={i} className="ss-diff__line" data-kind={line.startsWith('+') && !line.startsWith('+++') ? 'add' : line.startsWith('-') && !line.startsWith('---') ? 'del' : line.startsWith('@@') ? 'hunk' : 'ctx'}>{line}{'\n'}</span>
      ))}
    </pre>
  )
}

function Issues({ issues, t }: { issues: readonly Issue[]; t: T }) {
  if (issues.length === 0) return null
  return (
    <ul className="ss-issues">
      {issues.map((i, n) => <li key={n} className="ss-issue"><Badge tone={i.level === 'error' ? 'error' : 'warn'}>{i.level === 'error' ? t('issueError') : t('issueWarn')}</Badge><span>{i.message}</span></li>)}
    </ul>
  )
}

export function ProposalCard({ proposal, t, workspace, compact, onDone }: { proposal: Proposal; t: T; workspace?: string | undefined; compact?: boolean; onDone: () => void }) {
  const [open, setOpen] = useState(!compact)
  const [editing, setEditing] = useState(false)
  const [text, setText] = useState(proposal.content)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<{ text: string; issues?: Issue[] } | undefined>()
  const [done, setDone] = useState<{ status: string; path?: string } | undefined>()
  const pending = proposal.status === 'pending' && done === undefined
  const status = done?.status ?? proposal.status
  const edited = text !== proposal.content
  const origin = proposal.origin.kind === 'reviewer' ? t('originReviewer') : t('originAgent')

  const decide = async (action: 'approve' | 'reject', suppress = false): Promise<void> => {
    setBusy(true); setError(undefined)
    try {
      const r = await call<{ status: string; path?: string }>('decide', { id: proposal.id, action, ...(action === 'approve' ? { text } : {}), ...(suppress ? { suppress: true } : {}), ...(workspace === undefined ? {} : { workspace }) })
      setDone(r)
      onDone()
    } catch (e) {
      setError({ text: e instanceof Error ? e.message : String(e), ...(e instanceof ApiError && e.issues !== undefined ? { issues: e.issues } : {}) })
    } finally { setBusy(false) }
  }

  const evidence = useMemo(() => proposal.evidence.filter(e => e.quote !== undefined).slice(0, 3), [proposal.evidence])

  return (
    <article className="ss-proposal" data-testid="ss-proposal" data-status={status} aria-label={`${proposal.kind} ${proposal.name}`}>
      <header className="ss-proposal__head">
        <div className="ss-row__top">
          <strong className="ss-proposal__title">{proposal.kind === 'improve' ? t('proposalImprove', { name: proposal.name }) : t('proposalNew', { name: proposal.name })}</strong>
          <Badge tone="info">{origin}</Badge>
          {status !== 'pending' && <Badge tone={status === 'rejected' || status === 'failed' || status === 'stale' ? 'warn' : 'info'}>{t(`status_${status}` as never)}</Badge>}
          <span className="ss-note">{relativeTime(proposal.createdAt)}</span>
        </div>
        <p className="ss-proposal__why">{proposal.rationale}</p>
        <p className="ss-note">{t('nothingWritten')}</p>
      </header>

      {proposal.closest.length > 0 && <p className="ss-note">{t('similarTo', { list: proposal.closest.map(c => `${c.name} (${String(c.score)})`).join(', ') })}</p>}
      {evidence.length > 0 && <ul className="ss-evidence">{evidence.map((e, i) => <li key={i} className="ss-note">“{e.quote}”</li>)}</ul>}

      <div className="ss-editor-bar">
        <Button size="sm" onClick={() => { setOpen(!open) }} aria-expanded={open}>{open ? t('hideContent') : proposal.kind === 'improve' ? t('showDiff') : t('showContent')}</Button>
        {pending && <Button size="sm" onClick={() => { setEditing(!editing); setOpen(true) }}>{editing ? t('stopEditing') : t('edit')}</Button>}
      </div>

      {open && (editing ? (
        <textarea className="ss-editor ss-mono" value={text} spellCheck={false} aria-label={t('editorLabel')} onChange={(e) => { setText(e.target.value) }} data-testid="ss-proposal-editor" />
      ) : proposal.kind === 'improve' && proposal.diff !== undefined ? (
        <DiffView diff={proposal.diff} />
      ) : (
        <pre className="ss-diff ss-mono" aria-label={t('editorLabel')}>{proposal.content}</pre>
      ))}

      <Issues issues={proposal.validation.issues} t={t} />
      {error !== undefined && <div className="ss-banner" data-tone="error" role="alert">{error.text}{error.issues !== undefined && <Issues issues={error.issues} t={t} />}</div>}
      {done?.path !== undefined && <div className="ss-banner" data-tone="success" role="status">{t('writtenTo', { path: done.path })}</div>}
      {proposal.failure !== undefined && status === 'stale' && <div className="ss-banner" data-tone="warn">{proposal.failure}</div>}

      {pending && (
        <div className="ss-editor-bar">
          <Button variant="primary" size="sm" disabled={busy} onClick={() => { void decide('approve') }}>{edited ? t('approveEdited') : t('approve')}</Button>
          <Button size="sm" disabled={busy} onClick={() => { void decide('reject') }}>{t('reject')}</Button>
          <Button size="sm" disabled={busy} onClick={() => { void decide('reject', true) }} title={t('rejectForeverHint')}>{t('rejectForever')}</Button>
        </div>
      )}
    </article>
  )
}
