// Browser half. Light on the boot path: only the sidebar entry (icon + label) and the dictionary register here; the
// page and the whole kit live in the one lazy chunk (views.tsx), loaded on first render.
// Slot contributions use ctx.slots.inject(...) so they wait for the declaring package, vanish when it collapses
// and leave with this plugin; the dictionary is registered as an owned effect.
import { Suspense, lazy } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import { locale } from './locale.ts'
import type { T } from './locale.ts'

const PANEL_ID = 'dsh-triggers'
/** The built-in "Automation tasks" entry sits at 10; Triggers follows it. */
const PANEL_ORDER = 11
/** dsh-hud's client selects the session in this hash fragment; used when the workspace UI service is not reachable. */
const HASH_KEY = '#dsh-hud-session='

const Panel = lazy(() => import('./views.tsx').then((m) => ({ default: m.Panel })))

function PanelIcon({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M9 1.75L3.25 9h4.25l-.75 5.25L12.75 7H8.5L9 1.75z" />
    </svg>
  )
}

function Lazy({ t, children }: { t: T; children: React.ReactNode }) {
  return <Suspense fallback={<div role="status" style={{ padding: 24, color: 'var(--dsw-alias-label-secondary)' }}>{t('loading')}</div>}>{children}</Suspense>
}

interface WorkspaceFace { openSession(target: string): void }

/**
 * Navigate to a chat inside DSH. The workspace UI service is read softly at click time (it is part of the shell, but
 * this plugin does not declare it as a dependency); without it, fall back to dsh-hud's hash fragment.
 */
export function makeOpenSession(ctx: Pick<Context, 'get'>): (sessionId: string) => void {
  return (sessionId) => {
    let face: unknown
    try { face = ctx.get('uiWorkspace' as never) } catch { face = undefined }
    if (face !== null && typeof face === 'object' && typeof (face as Partial<WorkspaceFace>).openSession === 'function') {
      (face as WorkspaceFace).openSession(sessionId)
      return
    }
    location.hash = HASH_KEY + encodeURIComponent(sessionId)
  }
}

export const inject = ['slots', 'locale']

export function apply(ctx: Context): void {
  const c = ctx as Context & { locale: Parameters<typeof locale.register>[0]; slots: any } // eslint-disable-line
  ctx.effect(() => locale.register(c.locale), 'dsh-triggers: dictionary')
  const t = locale.bind(c.locale)
  const openSession = makeOpenSession(ctx)

  c.slots.inject('sidebar.panellist', () => c.slots.register({
    name: 'sidebar.panellist', id: PANEL_ID, order: PANEL_ORDER, label: () => t('panel'),
  }, PanelIcon))

  c.slots.inject('main', () => c.slots.register({
    name: 'main', key: PANEL_ID,
  }, () => <Lazy t={t}><Panel t={t} openSession={openSession} /></Lazy>))
}
