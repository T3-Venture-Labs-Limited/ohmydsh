// Tools tab: pick a connected app (display name + logo), tools load on selection; manual refresh stays.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Button, Card, EmptyState, Modal, Section, Select, TextField } from '../kit/index.ts'
import { toolkitName } from '../shared/connections.ts'
import { call } from './api.ts'
import type { State, ToolSummary } from './api.ts'
import type { T } from './locale.ts'
import { Badge, Logo } from './ui.tsx'

const LONG = 140

function ToolRow({ t, tool, onOpen }: { t: T; tool: ToolSummary; onOpen: () => void }) {
  const [expanded, setExpanded] = useState(false)
  const long = tool.description.length > LONG
  const risk = tool.risk
  return (
    <div className="co-row">
      <div className="co-row__text">
        <span className="co-row__title">{tool.name}</span>
        <span className="co-row__mono">{tool.slug}</span>
        {tool.description !== '' && <span className="co-row__desc" data-clamped={long && !expanded}>{tool.description}</span>}
        {long && <button type="button" className="co-row__more" aria-expanded={expanded} onClick={() => { setExpanded(!expanded) }}>{expanded ? t('showLess') : t('showMore')}</button>}
      </div>
      <div className="co-row__controls">
        <Badge tone={risk === 'read' ? 'ok' : risk === 'destructive' ? 'error' : risk === 'write' ? 'warn' : 'idle'}>
          {risk === 'read' ? t('riskRead') : risk === 'write' ? t('riskWrite') : risk === 'destructive' ? t('riskDestructive') : t('riskUnknown')}
        </Badge>
        <Button variant="outline" size="sm" onClick={onOpen}>{t('schema')}</Button>
      </div>
    </div>
  )
}

export function Tools({ t, state }: { t: T; state: State }) {
  const apps = useMemo(() => [...(state.connections ?? [])].sort((a, b) => toolkitName(a).localeCompare(toolkitName(b), 'en', { sensitivity: 'base' })), [state.connections])
  const [toolkit, setToolkit] = useState(apps[0]?.slug ?? '')
  const [query, setQuery] = useState('')
  const [tools, setTools] = useState<ToolSummary[] | undefined>()
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState<string | undefined>()
  const [detail, setDetail] = useState<ToolSummary | undefined>()
  const [schema, setSchema] = useState<string | undefined>()
  const [args, setArgs] = useState('{}')
  const [dry, setDry] = useState<string | undefined>()
  const seq = useRef(0)
  const current = apps.find((a) => a.slug === toolkit)

  const load = useCallback(async (slug: string, q: string): Promise<void> => {
    if (slug === '') return
    const mine = ++seq.current
    setLoading(true); setErr(undefined)
    try { const list = await call<ToolSummary[]>('tools', { toolkit: slug, ...(q === '' ? {} : { query: q }) }); if (mine === seq.current) setTools(list) }
    catch (e) { if (mine === seq.current) { setErr(e instanceof Error ? e.message : String(e)); setTools(undefined) } }
    finally { if (mine === seq.current) setLoading(false) }
  }, [])

  // Selecting an app loads its tools; typing in the filter reloads after a short pause.
  useEffect(() => {
    if (toolkit === '' && apps[0] !== undefined) { setToolkit(apps[0].slug); return }
    const timer = setTimeout(() => { void load(toolkit, query.trim()) }, query === '' ? 0 : 350)
    return () => { clearTimeout(timer) }
  }, [toolkit, query, apps, load])

  const open = async (tool: ToolSummary): Promise<void> => {
    setDetail(tool); setSchema(undefined); setDry(undefined); setArgs('{}')
    try { setSchema(JSON.stringify(await call<unknown>('schema', { slug: tool.slug }), null, 2)) } catch (e) { setSchema(e instanceof Error ? e.message : String(e)) }
  }
  const doDry = async (): Promise<void> => {
    if (detail === undefined) return
    try { JSON.parse(args) } catch { setDry('Arguments are not valid JSON.'); return }
    try { const r = await call<{ text: string }>('dryRun', { slug: detail.slug, arguments: JSON.parse(args) as unknown }); setDry(r.text) } catch (e) { setDry(e instanceof Error ? e.message : String(e)) }
  }

  if (apps.length === 0) return <Section title={t('toolsTitle')}><Card><EmptyState title={t('toolsNoApps')} description={t('toolsNoAppsHint')} /></Card></Section>
  return (
    <Section title={t('toolsTitle')}>
      <Card padded>
        <div className="co-picker">
          <div className="co-picker__app">
            <Logo name={current === undefined ? '' : toolkitName(current)} src={current?.logo} />
            <Select label={t('toolsPick')} value={toolkit} onChange={(v) => { setToolkit(v); setQuery('') }} options={apps.map((a) => ({ value: a.slug, label: toolkitName(a) }))} />
          </div>
          <TextField label={t('toolsSearch')} type="search" value={query} onChange={(e) => { setQuery(e.target.value) }} autoComplete="off" spellCheck={false} />
          <Button variant="outline" disabled={toolkit === '' || loading} onClick={() => { void load(toolkit, query.trim()) }}>{t('toolsRefresh')}</Button>
        </div>
        {err !== undefined && <div role="alert" className="co-error" style={{ marginTop: 12 }}>{err}</div>}
      </Card>
      {tools === undefined
        ? (loading ? <div role="status" className="co-loading">{t('toolsLoading')}</div> : err === undefined && <Card><EmptyState title={t('toolsEmpty')} description={t('toolsEmptyHint')} /></Card>)
        : tools.length === 0
          ? <Card><EmptyState title={t('toolsNone')} description={t('toolsNoneHint')} /></Card>
          : (
            <>
              <span className="co-summary" role="status">{loading ? t('toolsLoading') : tools.length === 1 ? t('toolCountOne') : t('toolCount', { count: tools.length })}</span>
              <Card>{tools.map((tool) => <ToolRow key={tool.slug} t={t} tool={tool} onOpen={() => { void open(tool) }} />)}</Card>
            </>
          )}
      <Modal open={detail !== undefined} onClose={() => { setDetail(undefined) }} title={detail?.name ?? ''} {...(detail === undefined ? {} : { description: detail.slug })} closeLabel={t('close')}>
        <div style={{ display: 'grid', gap: 8 }}>
          <strong>{t('schemaTitle')}</strong>
          <pre className="co-row__mono" style={{ maxHeight: 260, overflow: 'auto', margin: 0, whiteSpace: 'pre-wrap' }}>{schema ?? t('loading')}</pre>
          <strong>{t('dryRunTitle')}</strong>
          <TextField label={t('dryRunArgs')} value={args} onChange={(e) => { setArgs(e.target.value) }} hint={t('dryRunNote')} />
          <div><Button variant="outline" size="sm" onClick={() => { void doDry() }}>{t('dryRun')}</Button></div>
          {dry !== undefined && <pre className="co-row__mono" style={{ maxHeight: 180, overflow: 'auto', margin: 0, whiteSpace: 'pre-wrap' }}>{dry}</pre>}
        </div>
      </Modal>
    </Section>
  )
}
