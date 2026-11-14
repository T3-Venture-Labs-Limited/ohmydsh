// Browser half. Boot path stays tiny: this file registers the sidebar icon and the main page; the page itself is a lazy chunk.
import { Suspense, lazy } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import { locale } from './locale.ts'
import type { T } from './locale.ts'
import type { PageServices } from './Page.tsx'
import { configureSummary, subscribeSummary as subscribeRaw, useSummary } from './events.ts'
import { createPushTransport } from '../kit/push/transport.ts'

const PANEL_ID = 'skills'
const SkillsPage = lazy(() => import('./views.tsx').then((m) => ({ default: m.SkillsPage })))
const TurnCards = lazy(() => import('./views.tsx').then((m) => ({ default: m.TurnCards })))

function PanelIcon({ size }: { size: number }) {
  const { pending } = useSummary()
  return (
    <span className="ss-iconwrap" style={{ position: 'relative', display: 'inline-flex' }}>
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M8 1.8l1.6 3.4 3.7.5-2.7 2.6.7 3.7L8 10.2l-3.3 1.8.7-3.7L2.7 5.7l3.7-.5L8 1.8z" />
      <path d="M3 14h10" />
    </svg>
    {pending > 0 && <span aria-label={`${String(pending)} pending`} role="status" style={{ position: 'absolute', top: -4, right: -6, minWidth: 14, height: 14, padding: '0 3px', boxSizing: 'border-box', borderRadius: 7, background: 'var(--dsw-alias-brand-primary)', color: 'var(--dsw-alias-label-on-color)', fontSize: 10, lineHeight: '14px', textAlign: 'center', fontWeight: 600 }}>{pending > 9 ? '9+' : pending}</span>}
    </span>
  )
}

interface SessionsFace { list: { getSnapshot(): { current?: unknown; byId?: Record<string, { cwd?: string; retainedBy?: { mainView?: number } } | undefined> } }; scope?(id: string): { sessionId: string; cwd?: string } }
interface BetterSidebar { openFile?(scope: { sessionId: string; cwd?: string }, path: string, title?: string): void }

function currentSession(ctx: Context): { id: string; cwd?: string } | undefined {
  const sessions = ctx.get('sessions' as never) as SessionsFace | undefined
  const snap = sessions?.list.getSnapshot()
  if (snap === undefined) return undefined
  let id = snap.current === undefined ? undefined : String(snap.current)
  if (id === undefined && snap.byId !== undefined) {
    for (const [k, v] of Object.entries(snap.byId)) if ((v?.retainedBy?.mainView ?? 0) > 0) { id = k; break }
  }
  if (id === undefined) return undefined
  const cwd = snap.byId?.[id]?.cwd
  return { id, ...(cwd === undefined ? {} : { cwd }) }
}

/** Switch the central column to the Skills panel (same effect as clicking its sidebar icon). */
function openSkillsPage(ctx: Context): void {
  const layout = ctx.get('layout' as never) as { selectPanel?(id: string): void } | undefined
  layout?.selectPanel?.(PANEL_ID)
}

export const inject = ['slots', 'locale']

export function apply(ctx: Context): void {
  const c = ctx as Context & { locale: Parameters<typeof locale.register>[0]; slots: any } // eslint-disable-line
  ctx.effect(() => locale.register(c.locale), 'skill-studio: dictionary')
  const t: T = locale.bind(c.locale)

  // Live summary: a Typert stream on DSH's single multiplexed WebSocket (no HTTP stream; the browser allows only 6 per host).
  const transport = createPushTransport(ctx as never, { pkg: 'dsh-skill-studio', serviceKey: 'dshSkillStudio', namespace: 'dshSkillStudio', streams: [{ method: 'summary' }] })
  ctx.effect(() => { configureSummary((signal) => transport.stream('summary', [], signal)); return () => { configureSummary(undefined) } }, 'skill-studio: summary stream')

  const services: PageServices = {
    currentCwd: () => currentSession(ctx)?.cwd,
    openInSidebar: (path, title) => {
      const session = currentSession(ctx)
      const bs = ctx.get('betterSidebar' as never) as BetterSidebar | undefined
      if (session === undefined || typeof bs?.openFile !== 'function') return false
      bs.openFile({ sessionId: session.id, ...(session.cwd === undefined ? {} : { cwd: session.cwd }) }, path, title)
      return true
    },
    useSummary,
    subscribeSummary: (listener) => subscribeRaw(() => { listener() }),
    onFocus: (listener) => {
      const onVisible = (): void => { if (document.visibilityState === 'visible') listener() }
      window.addEventListener('focus', listener)
      document.addEventListener('visibilitychange', onVisible)
      return () => { window.removeEventListener('focus', listener); document.removeEventListener('visibilitychange', onVisible) }
    },
  }
  const pageServices: PageServices = { ...services }

  c.slots.inject('sidebar.panellist', () => c.slots.register({
    name: 'sidebar.panellist', id: PANEL_ID, order: 20, label: () => t('panel'),
  }, PanelIcon))

  // Inline approval card under the completed turn that created the proposal (Approve / Edit / Reject, full content or diff).
  c.slots.inject('conversation.chat.turnTail', () => c.slots.register({
    name: 'conversation.chat.turnTail', id: 'skill-studio-proposals', order: 30,
    inject: (sessionId: string) => ({ sessionId }),
  }, (props: { sessionId?: string; turn?: { start?: { time?: number }; end?: { time?: number }; status?: string } }) => {
    const start = props.turn?.start?.time
    const end = props.turn?.end?.time
    if (props.sessionId === undefined || start === undefined || end === undefined) return null
    return (
      <Suspense fallback={null}>
        <TurnCards t={t} sessionId={props.sessionId} from={start} to={end + 5000} subscribe={pageServices.subscribeSummary} openPage={() => { openSkillsPage(ctx) }} />
      </Suspense>
    )
  }))

  c.slots.inject('main', () => c.slots.register({
    name: 'main', key: PANEL_ID,
  }, () => (
    <Suspense fallback={<div role="status" style={{ padding: 24, color: 'var(--dsw-alias-label-secondary)' }}>{t('loading')}</div>}>
      <SkillsPage t={t} services={pageServices} />
    </Suspense>
  )))
}
