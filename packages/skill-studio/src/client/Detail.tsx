import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Button, IconButton, IconClose } from '../kit/index.ts'
import { ApiError, call, type Issue, type ReadResult, type SaveResult, type SkillRow, type ValidateResult } from './api.ts'
import { Badge } from './Row.tsx'
import { relativeTime, sourceLabel } from './helpers.ts'
import type { T } from './locale.ts'

export interface DetailServices {
  /** Open `path` in the better-sidebar editor, when a session and the service exist. */
  openInSidebar?: (path: string, title: string) => boolean
  workspace?: string | undefined
}

function IssueList({ issues, t }: { issues: readonly Issue[]; t: T }) {
  return (
    <ul className="ss-issues">
      {issues.map((i, n) => (
        <li key={`${i.code}-${String(n)}`} className="ss-issue">
          <Badge tone={i.level === 'error' ? 'error' : 'warn'}>{i.level === 'error' ? t('issueError') : t('issueWarn')}</Badge>
          <span>{i.message}{i.line === undefined ? '' : ` (${t('issueLine', { line: i.line })})`}</span>
        </li>
      ))}
    </ul>
  )
}

function invocationText(row: SkillRow, t: T): string {
  if (row.modelInvocable && row.userInvocable) return t('invocationBoth')
  if (row.userInvocable) return t('invocationUserOnly')
  if (row.modelInvocable) return t('invocationModelOnly')
  return t('invocationNone')
}

export function Detail({ row, t, services, onClose, onChanged }: {
  row: SkillRow
  t: T
  services: DetailServices
  onClose: () => void
  onChanged: () => void
}) {
  const [file, setFile] = useState<ReadResult | undefined>()
  const [text, setText] = useState('')
  const [loadError, setLoadError] = useState<string | undefined>()
  const [validation, setValidation] = useState<ValidateResult | undefined>()
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<{ tone: 'error' | 'success' | 'warn'; text: string } | undefined>()
  const [duplicating, setDuplicating] = useState(false)
  const timer = useRef<number | undefined>(undefined)
  const pluginOnly = row.source === 'plugin' && row.path === undefined

  const load = useCallback(async () => {
    setLoadError(undefined); setMessage(undefined)
    try {
      const r = await call<ReadResult>('read', { id: row.id, ...(services.workspace === undefined ? {} : { workspace: services.workspace }) })
      setFile(r); setText(r.text); setValidation(undefined)
    } catch (e) { setLoadError(e instanceof Error ? e.message : String(e)) }
  }, [row.id, services.workspace])

  useEffect(() => { setFile(undefined); setText(''); if (!pluginOnly) void load() }, [load, pluginOnly])

  const dirty = file !== undefined && text !== file.text
  // Live validation, debounced: the host validates with the same rules the DSH filesystem provider applies.
  useEffect(() => {
    if (file === undefined || !dirty) { setValidation(undefined); return }
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => {
      void call<ValidateResult>('validate', { text, dirName: row.dirName }).then(setValidation).catch(() => { setValidation(undefined) })
    }, 250)
    return () => { window.clearTimeout(timer.current) }
  }, [text, dirty, file, row.dirName])

  const issues = useMemo<Issue[]>(() => (dirty && validation !== undefined ? validation.issues : file?.issues ?? row_issues(row)), [dirty, validation, file, row])
  const wouldLoad = dirty && validation !== undefined ? validation.wouldLoad : file?.wouldLoad ?? row.wouldLoad
  const editable = file?.editable === true

  const save = useCallback(async () => {
    if (file === undefined || !dirty) return
    setSaving(true); setMessage(undefined)
    try {
      const r = await call<SaveResult>('save', { id: row.id, text, baseSha256: file.sha256, ...(services.workspace === undefined ? {} : { workspace: services.workspace }) })
      setFile({ ...file, text: text.endsWith('\n') ? text : `${text}\n`, sha256: r.sha256, issues: r.issues, wouldLoad: r.wouldLoad })
      setText(text.endsWith('\n') ? text : `${text}\n`)
      setMessage({ tone: 'success', text: `${t('saved')} ${t('savedBackup', { path: r.backup })}` })
      onChanged()
    } catch (e) {
      if (e instanceof ApiError && e.code === 'conflict') setMessage({ tone: 'warn', text: t('conflict') })
      else if (e instanceof ApiError && e.issues !== undefined) { setValidation({ wouldLoad: false, issues: e.issues, name: null, description: null, modelInvocable: true, userInvocable: true }); setMessage({ tone: 'error', text: e.message }) }
      else setMessage({ tone: 'error', text: e instanceof Error ? e.message : String(e) })
    } finally { setSaving(false) }
  }, [file, dirty, row.id, text, services.workspace, t, onChanged])

  const duplicate = useCallback(async () => {
    setDuplicating(true); setMessage(undefined)
    try {
      const r = await call<{ path: string }>('duplicate', { id: row.id, name: row.name, target: 'user-dsh', ...(services.workspace === undefined ? {} : { workspace: services.workspace }) })
      setMessage({ tone: 'success', text: t('duplicateDone', { path: r.path }) })
      onChanged()
    } catch (e) { setMessage({ tone: 'error', text: `${t('duplicateFailed')}: ${e instanceof Error ? e.message : String(e)}` }) } finally { setDuplicating(false) }
  }, [row.id, row.name, services.workspace, t, onChanged])

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); void save() }
  }

  return (
    <aside className="ss-detail" aria-label={row.name} data-testid="ss-detail">
      <div className="ss-detail__head">
        <div>
          <h2 className="ss-detail__title">{row.name}</h2>
          <div className="ss-row__top" style={{ marginTop: 6 }}>
            <Badge>{sourceLabel(t, row.source)}</Badge>
            {row.state === 'shadowed' && <Badge tone="warn">{t('stateShadowed')}</Badge>}
            {row.state === 'invalid' && <Badge tone="error">{t('stateInvalid')}</Badge>}
          </div>
        </div>
        <IconButton label={t('detailClose')} icon={<IconClose size={14} />} onClick={onClose} />
      </div>
      {row.description !== '' && <p className="ss-note" style={{ fontSize: 13, color: 'var(--dsw-alias-label-secondary)' }}>{row.description}</p>}
      <dl className="ss-kv">
        {row.path !== undefined && (<><dt>{t('detailPath')}</dt><dd className="ss-mono">{row.path}</dd></>)}
        {row.realPath !== undefined && row.realPath !== row.path && (<><dt>{t('detailRealPath')}</dt><dd className="ss-mono">{row.realPath}</dd></>)}
        {row.provider !== undefined && (<><dt>Provider</dt><dd>{row.provider}</dd></>)}
        <dt>{t('detailInvocation')}</dt><dd>{invocationText(row, t)}</dd>
        {row.mtimeMs !== undefined && (<><dt>Modified</dt><dd>{relativeTime(row.mtimeMs)}</dd></>)}
        {row.usage !== undefined && (<><dt>Usage</dt><dd>{t('usageCount', { count: row.usage.count })} · {t('usageWhen', { when: relativeTime(row.usage.lastUsed) })}</dd></>)}
      </dl>

      {pluginOnly && <div className="ss-banner">{t('pluginNote')}</div>}
      {!pluginOnly && file !== undefined && !editable && <div className="ss-banner" data-tone="warn">{file.readOnlyReason === 'system' ? t('readOnlySystem') : file.readOnlyReason === 'outside-root' ? t('readOnlyOutsideRoot') : t('readOnlyPermission')}</div>}
      {loadError !== undefined && <div className="ss-banner" data-tone="error">{loadError}</div>}

      {!pluginOnly && (
        <section>
          <h3 className="ss-section-title">{t('detailIssues')}</h3>
          <p className={wouldLoad ? 'ss-ok' : 'ss-bad'}>{wouldLoad ? t('wouldLoadYes') : t('wouldLoadNo')}</p>
          {issues.length === 0 ? <p className="ss-note">{t('detailNoIssues')}</p> : <IssueList issues={issues} t={t} />}
        </section>
      )}

      {!pluginOnly && file !== undefined && (
        <section style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <label className="ss-section-title" htmlFor={`ss-ed-${row.id}`}>{t('editorLabel')}</label>
          <textarea id={`ss-ed-${row.id}`} className="ss-editor ss-mono" spellCheck={false} readOnly={!editable} value={text} data-testid="ss-editor"
            onChange={(e) => { setText(e.target.value) }} onKeyDown={onKeyDown} />
          <div className="ss-editor-bar">
            {editable && <Button variant="primary" size="sm" disabled={!dirty || saving} onClick={() => { void save() }}>{saving ? t('saving') : t('save')}</Button>}
            {editable && <Button size="sm" disabled={!dirty || saving} onClick={() => { setText(file.text) }}>{t('revert')}</Button>}
            <Button size="sm" onClick={() => { void load() }}>{t('reload')}</Button>
            {services.openInSidebar !== undefined && (
              <Button size="sm" onClick={() => { setMessage(services.openInSidebar?.(file.realPath, row.name) === true ? { tone: 'success', text: t('openedInSidebar') } : { tone: 'warn', text: t('openInSidebarUnavailable') }) }}>{t('openInSidebar')}</Button>
            )}
            {!editable && !pluginOnly && row.source !== 'user-dsh' && <Button size="sm" disabled={duplicating} onClick={() => { void duplicate() }} title={t('duplicateHint')}>{t('duplicate')}</Button>}
            {dirty && <span className="ss-note">{validation === undefined ? t('validating') : t('unsaved')}</span>}
          </div>
        </section>
      )}
      {message !== undefined && <div className="ss-banner" data-tone={message.tone} role={message.tone === 'error' ? 'alert' : 'status'}>{message.text}</div>}
    </aside>
  )
}

function row_issues(_row: SkillRow): Issue[] { return [] }
