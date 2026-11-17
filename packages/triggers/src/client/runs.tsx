// Runs table: time, automation, event summary, status (+ reason / error), model, Open chat. Used on the main page and,
// filtered to one automation, on the detail view.
import { useState } from 'react'
import { Button, Card, EmptyState } from '../kit/index.ts'
import type { RunRow } from '../shared/types.ts'
import type { T } from './locale.ts'
import { Badge, RunBadge, TimeAgo } from './ui.tsx'

const PAGE = 20

export function RunsTable({ t, runs, openSession, showAutomation = true }: { t: T; runs: readonly RunRow[]; openSession: (id: string) => void; showAutomation?: boolean }) {
  const [shown, setShown] = useState(PAGE)
  if (runs.length === 0) return <Card><EmptyState title={t('runsEmpty')} description={t('runsEmptyHint')} /></Card>
  return (
    <Card padded>
      <div className="tr-table-wrap">
        <table className="tr-table" data-testid="runs">
          <thead>
            <tr>
              <th scope="col">{t('colTime')}</th>
              {showAutomation && <th scope="col">{t('colAutomation')}</th>}
              <th scope="col">{t('colSummary')}</th>
              <th scope="col">{t('colStatus')}</th>
              <th scope="col">{t('colModel')}</th>
              <th scope="col"><span className="dk-visually-hidden">{t('colActions')}</span></th>
            </tr>
          </thead>
          <tbody>
            {runs.slice(0, shown).map((r) => <RunTableRow key={r.runId} t={t} run={r} openSession={openSession} showAutomation={showAutomation} />)}
          </tbody>
        </table>
      </div>
      {runs.length > shown && (
        <div className="tr-actions" style={{ marginTop: 8 }}>
          <Button variant="ghost" size="sm" onClick={() => { setShown((n) => n + PAGE) }}>{t('showMore')}</Button>
        </div>
      )}
    </Card>
  )
}

function RunTableRow({ t, run, openSession, showAutomation }: { t: T; run: RunRow; openSession: (id: string) => void; showAutomation: boolean }) {
  const detail = run.error ?? run.reason
  const bad = run.status === 'failed' || run.status === 'rejected'
  return (
    <tr data-run={run.runId}>
      <td className="tr-table__time"><TimeAgo t={t} at={run.at} /></td>
      {showAutomation && <td>{run.automationName}</td>}
      <td>{run.summary}{run.test === true && <> <Badge tone="idle">{t('testBadge')}</Badge></>}</td>
      <td>
        <RunBadge t={t} status={run.status} />
        {detail !== undefined && detail !== '' && <span className="tr-table__reason" data-tone={bad ? 'error' : undefined}>{detail}</span>}
      </td>
      <td>{run.model ?? <span className="tr-table__muted">—</span>}</td>
      <td>
        {run.sessionId !== undefined && run.sessionId !== '' && (
          <Button variant="outline" size="sm" onClick={() => { openSession(run.sessionId ?? '') }}>{t('openChat')}</Button>
        )}
      </td>
    </tr>
  )
}
