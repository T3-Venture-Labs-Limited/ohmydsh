// Inline approval cards under a completed turn: proposals this session created during THIS turn (matched by time window).
import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '../kit/index.ts'
import { call, type Proposal, type ProposalsResult } from './api.ts'
import { ProposalCard } from './ProposalCard.tsx'
import type { T } from './locale.ts'
import { useStudioStyles } from './styles.ts'
import { useKitStyles } from '../kit/styles.ts'

export function TurnCards({ t, sessionId, from, to, subscribe, openPage }: { t: T; sessionId: string; from: number; to: number; subscribe: (l: () => void) => () => void; openPage: () => void }) {
  useKitStyles()
  useStudioStyles()
  const [mine, setMine] = useState<Proposal[]>([])
  // Cards stay visible after a decision (success banner) for as long as this turn is mounted.
  const seen = useRef(new Set<string>())
  const load = useCallback(async () => {
    try {
      const r = await call<ProposalsResult>('proposals')
      const here = r.proposals.filter(p => p.origin.sessionId === sessionId && p.createdAt >= from && p.createdAt <= to)
      for (const p of here) if (p.status === 'pending') seen.current.add(p.id)
      setMine(here.filter(p => seen.current.has(p.id)).sort((a, b) => a.createdAt - b.createdAt))
    } catch { /* the Skills page shows load errors; a missing card is not fatal */ }
  }, [sessionId, from, to])
  useEffect(() => { void load() }, [load])
  useEffect(() => subscribe(() => { void load() }), [subscribe, load])
  if (mine.length === 0) return null
  return (
    <div className="ss-turncards" data-testid="ss-turncards" role="region" aria-label={t('turnCardTitle')}>
      {mine.map(p => <ProposalCard key={p.id} proposal={p} t={t} compact onDone={() => { void load() }} />)}
      <div><Button size="sm" onClick={openPage}>{t('openProposals')}</Button></div>
    </div>
  )
}
