// Browser half. The only UI is a Settings page (install state, links, notification permission); the installable
// app itself is served by the host half (manifest, service worker, /m, /share). The page loads lazily.
import { Suspense, lazy } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import { locale } from './locale.ts'

const SettingsPage = lazy(() => import('./views.tsx').then((m) => ({ default: m.SettingsPage })))

function Lazy({ children }: { children: React.ReactNode }) {
  return <Suspense fallback={<div role="status" style={{ padding: 24, color: 'var(--dsw-alias-label-secondary)' }}>…</div>}>{children}</Suspense>
}

export const inject = ['slots', 'locale']

export function apply(ctx: Context): void {
  const c = ctx as Context & { locale: Parameters<typeof locale.register>[0]; slots: any } // eslint-disable-line
  ctx.effect(() => locale.register(c.locale), 'dsh-pwa: dictionary')
  const t = locale.bind(c.locale)

  c.slots.inject('settings.section', () => c.slots.register({
    name: 'settings.section', id: 'dsh-pwa', order: 130, label: () => t('nav'),
  }, () => <Lazy><SettingsPage t={t} /></Lazy>))
}
