// Browser half. Light on the boot path: the settings page and the panel are lazy chunks loaded on first render.
// Slot contributions use ctx.slots.inject(...) so they wait for the declaring package, vanish when it collapses
// and leave with this plugin; the dictionary is registered as an owned effect.
import { Suspense, lazy } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import { locale } from './locale.ts'
import type { T } from './locale.ts'

const PANEL_ID = '__ID__'

// Both views come from one lazy chunk (views.tsx) so the kit is bundled into exactly one self-contained file.
const SettingsPage = lazy(() => import('./views.tsx').then((m) => ({ default: m.SettingsPage })))
const Panel = lazy(() => import('./views.tsx').then((m) => ({ default: m.Panel })))

function PanelIcon({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="2.5" y="2.5" width="4.5" height="4.5" rx="1.2" />
      <rect x="9" y="2.5" width="4.5" height="4.5" rx="1.2" />
      <rect x="2.5" y="9" width="4.5" height="4.5" rx="1.2" />
      <rect x="9" y="9" width="4.5" height="4.5" rx="1.2" />
    </svg>
  )
}

function Lazy({ t, children }: { t: T; children: React.ReactNode }) {
  return <Suspense fallback={<div role="status" style={{ padding: 24, color: 'var(--dsw-alias-label-secondary)' }}>{t('panelLoading')}</div>}>{children}</Suspense>
}

export const inject = ['slots', 'locale']

export function apply(ctx: Context): void {
  const c = ctx as Context & { locale: Parameters<typeof locale.register>[0]; slots: any } // eslint-disable-line
  ctx.effect(() => locale.register(c.locale), '__ID__: dictionary')
  const t = locale.bind(c.locale)

  c.slots.inject('settings.section', () => c.slots.register({
    name: 'settings.section', id: '__ID__', order: 120, label: () => t('nav'),
  }, () => <Lazy t={t}><SettingsPage t={t} /></Lazy>))

  c.slots.inject('sidebar.panellist', () => c.slots.register({
    name: 'sidebar.panellist', id: PANEL_ID, order: 60, label: () => t('panel'),
  }, PanelIcon))

  c.slots.inject('main', () => c.slots.register({
    name: 'main', key: PANEL_ID,
  }, () => <Lazy t={t}><Panel t={t} /></Lazy>))
}
