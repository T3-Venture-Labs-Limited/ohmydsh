// Browser half. Light on the boot path: the settings page and the panel are lazy chunks loaded on first render.
// Slot contributions use ctx.slots.inject(...) so they wait for the declaring package, vanish when it collapses
// and leave with this plugin; the dictionary is registered as an owned effect.
import { Suspense, lazy } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import { locale } from './locale.ts'
import type { T } from './locale.ts'

const PANEL_ID = 'dsh-composio'

// Both views come from one lazy chunk (views.tsx) so the kit is bundled into exactly one self-contained file.
const Panel = lazy(() => import('./views.tsx').then((m) => ({ default: m.Panel })))

function PanelIcon({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="4" cy="8" r="1.8" />
      <circle cx="12" cy="4" r="1.8" />
      <circle cx="12" cy="12" r="1.8" />
      <path d="M5.6 7.2l4.8-2.4M5.6 8.8l4.8 2.4" />
    </svg>
  )
}

function Lazy({ t, children }: { t: T; children: React.ReactNode }) {
  return <Suspense fallback={<div role="status" style={{ padding: 24, color: 'var(--dsw-alias-label-secondary)' }}>{t('loading')}</div>}>{children}</Suspense>
}

export const inject = ['slots', 'locale']

export function apply(ctx: Context): void {
  const c = ctx as Context & { locale: Parameters<typeof locale.register>[0]; slots: any } // eslint-disable-line
  ctx.effect(() => locale.register(c.locale), 'dsh-composio: dictionary')
  const t = locale.bind(c.locale)

  c.slots.inject('sidebar.panellist', () => c.slots.register({
    name: 'sidebar.panellist', id: PANEL_ID, order: 62, label: () => t('panel'),
  }, PanelIcon))

  c.slots.inject('main', () => c.slots.register({
    name: 'main', key: PANEL_ID,
  }, () => <Lazy t={t}><Panel t={t} /></Lazy>))
}
