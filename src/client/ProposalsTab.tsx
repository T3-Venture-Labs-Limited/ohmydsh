import { useCallback, useEffect, useState } from 'react'
import { Button, EmptyState } from '../kit/index.ts'
import { call, type ProposalsResult } from './api.ts'
import { ProposalCard } from './ProposalCard.tsx'
import type { T } from './locale.ts'

export function ProposalsTab({ t, workspace, subscribe }: { t: T; workspace?: string | undefined; subscribe: (listener: () => void) => () => void }) {
  const [data, setData] = useState<ProposalsResult | undefined>()
  const [error, setError] = useState<string | undefined>()
  const [showDone, setShowDone] = useState(false)
  const load = useCallback(async () => {
    try { setData(await call<ProposalsResult>('proposals')); setError(undefined) } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
  }, [])
  useEffect(() => { void load() }, [load])
  // Pushed by the host whenever a proposal is queued or decided (no timers).
  useEffect(() => subscribe(() => { void load() }), [subscribe, load])

  if (error !== undefined && data === undefined) return <EmptyState tone="error" title={t('loadError')} description={error} actions={<Button size="sm" onClick={() => { void load() }}>{t('retry')}</Button>} />
  if (data === undefined) return <div className="ss-center" role="status">{t('loading')}</div>
  const pending = data.proposals.filter(p => p.status === 'pending')
  const decided = data.proposals.filter(p => p.status !== 'pending')
  return (
    <div className="ss-proposals" data-testid="ss-proposals">
      {pending.length === 0 ? <EmptyState title={t('noProposals')} description={t('noProposalsDescription')} /> : pending.map(p => <ProposalCard key={p.id} proposal={p} t={t} workspace={workspace} onDone={() => { void load() }} />)}
      {decided.length > 0 && (
        <div>
          <Button size="sm" onClick={() => { setShowDone(!showDone) }}>{showDone ? t('hideDecided') : t('showDecided', { count: decided.length })}</Button>
          {showDone && <div className="ss-proposals" style={{ marginTop: 12 }}>{decided.slice(0, 30).map(p => <ProposalCard key={p.id} proposal={p} t={t} compact onDone={() => { void load() }} />)}</div>}
        </div>
      )}
    </div>
  )
}
