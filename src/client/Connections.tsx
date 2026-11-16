// Connections tab: summary, search + status filter, one card per app with its accounts, and the connect form.
import { useMemo, useState } from 'react'
import { Button, Card, EmptyState, Section, SegmentedControl, TextField, Tooltip } from '../kit/index.ts'
import { accountLabel, countToolkits, statusTone, toolkitName, toolkitNeedsAttention, visibleToolkits } from '../shared/connections.ts'
import type { StatusFilter } from '../shared/connections.ts'
import { call } from './api.ts'
import type { State } from './api.ts'
import type { T } from './locale.ts'
import { Badge, Logo } from './ui.tsx'

export function statusLabel(t: T, status: string): string {
  return status === 'ACTIVE' ? t('statusActive') : status === 'EXPIRED' ? t('statusExpired') : status === 'INITIALIZING' ? t('statusPending') : t('statusOther')
}

export function Connections({ t, state, busy, refresh }: { t: T; state: State; busy: boolean; refresh: () => void }) {
  const [toolkit, setToolkit] = useState('')
  const [alias, setAlias] = useState('')
  const [link, setLink] = useState<string | undefined>()
  const [err, setErr] = useState<string | undefined>()
  const [working, setWorking] = useState(false)
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<StatusFilter>('all')
  const rows = useMemo(() => state.connections ?? [], [state.connections])
  const shown = useMemo(() => visibleToolkits(rows, query, filter), [rows, query, filter])
  const counts = useMemo(() => countToolkits(rows), [rows])

  const start = async (slug: string, al?: string): Promise<void> => {
    setWorking(true); setErr(undefined); setLink(undefined)
    try { const r = await call<{ url: string }>('link', { toolkit: slug, ...(al === undefined || al === '' ? {} : { alias: al }) }); setLink(r.url) } catch (e) { setErr(e instanceof Error ? e.message : String(e)) } finally { setWorking(false) }
  }
  const summary = (
    <span className="co-summary" role="status">
      {counts.apps === 1 ? t('appCountOne') : t('appCount', { count: counts.apps })}
      {counts.attention > 0 && <> · <strong>{counts.attention === 1 ? t('needAttentionOne') : t('needAttention', { count: counts.attention })}</strong></>}
    </span>
  )

  return (
    <>
      <Section title={t('connectionsTitle')} description={t('removeNote')}>
        {rows.length === 0
          ? <Card><EmptyState title={t('connectionsEmpty')} description={t('connectionsEmptyHint')} /></Card>
          : (
            <>
              <div className="co-toolbar">
                <TextField
                  className="co-toolbar__search" label={t('searchApps')} hideLabel type="search" placeholder={t('searchApps')} value={query}
                  onChange={(e) => { setQuery(e.target.value) }} autoComplete="off" spellCheck={false}
                />
                <div className="co-toolbar__filters">
                  {summary}
                  <SegmentedControl
                    id="composio-filter" label={t('statusFilter')} value={filter} onChange={setFilter}
                    options={[{ value: 'all', label: t('filterAll') }, { value: 'active', label: t('filterActive') }, { value: 'attention', label: t('filterAttention') }]}
                  />
                </div>
              </div>
              {shown.length === 0
                ? (
                  <Card>
                    <EmptyState
                      title={t('noMatches')} description={t('noMatchesHint')}
                      actions={<Button variant="outline" size="sm" onClick={() => { setQuery(''); setFilter('all') }}>{t('clearFilters')}</Button>}
                    />
                  </Card>
                )
                : (
                  <div className="co-grid">
                    {shown.map((tk) => {
                      const name = toolkitName(tk)
                      return (
                        <article key={tk.slug} className="co-app" data-attention={toolkitNeedsAttention(tk) || undefined} aria-label={name}>
                          <div className="co-app__head">
                            <Logo name={name} src={tk.logo} />
                            <div className="co-app__text">
                              <span className="co-app__name" title={name}>{name}</span>
                              <span className="co-app__meta">{tk.accounts.length === 1 ? t('accountCountOne') : t('accountCount', { count: tk.accounts.length })}</span>
                            </div>
                          </div>
                          <ul className="co-accounts">
                            {tk.accounts.map((a, i) => {
                              const label = accountLabel(a, i)
                              return (
                                <li key={a.id ?? a.wordId} className="co-account">
                                  <div className="co-account__text">
                                    <span className="co-account__name">{label.primary}{label.detail !== null && <span className="co-app__meta"> · {label.detail}</span>}</span>
                                    {label.id !== '' && (
                                      <Tooltip label={t('accountIdTip', { id: label.id })} side="top"><span className="co-account__id" tabIndex={0}>{label.id}</span></Tooltip>
                                    )}
                                  </div>
                                  <div className="co-account__controls">
                                    <Badge tone={statusTone(a.status)} dot>{statusLabel(t, a.status)}</Badge>
                                    {a.status === 'EXPIRED' && <Button variant="outline" size="sm" disabled={working} onClick={() => { void start(tk.slug, a.alias ?? undefined) }}>{t('reauth')}</Button>}
                                  </div>
                                </li>
                              )
                            })}
                          </ul>
                        </article>
                      )
                    })}
                  </div>
                )}
            </>
          )}
      </Section>
      <Section title={t('connectTitle')}>
        <Card padded>
          <div className="co-form">
            <TextField label={t('toolkitLabel')} hint={t('toolkitHint')} value={toolkit} onChange={(e) => { setToolkit(e.target.value.trim().toLowerCase()) }} />
            <TextField label={t('aliasLabel')} hint={t('aliasHint')} value={alias} onChange={(e) => { setAlias(e.target.value) }} />
            <Button variant="primary" disabled={working || busy || toolkit === ''} onClick={() => { void start(toolkit, alias) }}>{t('addAccount')}</Button>
          </div>
          {err !== undefined && <div role="alert" className="co-error">{err}</div>}
          {link !== undefined && (
            <div className="co-actions" style={{ marginTop: 12 }}>
              <span>{t('linkReady')}</span>
              <a href={link} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--dsw-alias-brand-text)' }}>{t('openLink')}</a>
              <Button variant="outline" size="sm" onClick={refresh}>{t('refresh')}</Button>
            </div>
          )}
        </Card>
      </Section>
    </>
  )
}
