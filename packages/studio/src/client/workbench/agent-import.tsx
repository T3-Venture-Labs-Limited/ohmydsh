// "Import agent images and videos": reruns the host's backfill (existing chats + the agent media folders) and shows what happened.
// Idempotent and non-destructive; the same import runs automatically once on first start with this version.
import { useEffect, useState } from 'react'
import { Button, Modal } from '../../kit/index.js'
import { api } from './api.js'
import { t } from './i18n.js'
import type { AgentMediaSummary } from './types.js'
import { errorText } from './ui.js'

export function AgentMediaImport({ onDone }: { onDone: () => void }) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [summary, setSummary] = useState<AgentMediaSummary | undefined>()
  const [last, setLast] = useState<AgentMediaSummary | null | undefined>()
  const [count, setCount] = useState<number | undefined>()
  const [error, setError] = useState<string | undefined>()

  useEffect(() => {
    if (!open) return
    void api.agentMediaStatus().then(s => { setLast(s.last); setCount(s.count); if (s.running) setBusy(true) }, () => { setLast(null) })
  }, [open])

  const run = async (): Promise<void> => {
    setBusy(true); setError(undefined)
    try { const r = await api.agentMediaBackfill(); setSummary(r.summary); setLast(r.summary); onDone() } catch (e) { setError(errorText(e)) } finally { setBusy(false) }
  }
  const shown = summary ?? undefined
  return (<>
    <button type="button" className="st-link" onClick={() => { setOpen(true); setSummary(undefined) }}>{t('importAgent')}</button>
    <Modal open={open} onClose={() => { if (!busy) setOpen(false) }} title={t('importAgentTitle')} closeLabel={t('close')} description={t('importAgentHint')}
      footer={<><Button onClick={() => { setOpen(false) }} disabled={busy}>{t('close')}</Button><Button variant="primary" onClick={() => { void run() }} disabled={busy}>{busy ? t('importAgentBusy') : t('importAgentRun')}</Button></>}>
      <div className="st-col" style={{ gap: 10 }}>
        {count !== undefined && <p className="st-muted" style={{ margin: 0 }}>{t('assetsN', { n: count })} · {t('fromChats')}</p>}
        {busy && <div className="st-bar st-bar--indeterminate" role="status" aria-label={t('importAgentBusy')}><span /></div>}
        {error !== undefined && <p className="st-error" role="alert">{error}</p>}
        {shown !== undefined && (
          <div role="status" className="st-col" style={{ gap: 6 }}>
            <b>{t('importAgentDone')}</b>
            <dl className="st-kv">
              <dt>{t('importedN')}</dt><dd>{shown.imported}</dd>
              <dt>{t('alreadyThereN')}</dt><dd>{shown.alreadyThere}</dd>
              <dt>{t('skippedN')}</dt><dd>{shown.skipped}</dd>
              {shown.failed > 0 && <><dt>{t('failedN')}</dt><dd>{shown.failed}</dd></>}
              {shown.sessionsScanned !== undefined && <><dt>{t('scannedChats')}</dt><dd>{shown.sessionsScanned}</dd></>}
              <dt>{t('scannedFiles')}</dt><dd>{shown.filesScanned}</dd>
            </dl>
          </div>
        )}
        {shown === undefined && last !== undefined && last !== null && <p className="st-small st-dim">{t('lastRun')}: {new Date(last.at).toLocaleString()} · {t('importedN')} {last.imported}, {t('alreadyThereN')} {last.alreadyThere}, {t('skippedN')} {last.skipped}</p>}
      </div>
    </Modal>
  </>)
}
