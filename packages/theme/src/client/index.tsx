// Browser half. The controller (palette maths + token layer) is tiny and runs on the boot path; the settings page is a
// lazy chunk loaded on first render. One disposer (ctx.effect) removes the token layer and the stream.
// Nothing here writes the Appearance preference (it is shared by every browser signed in to the Host).
import { Suspense, lazy } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import { ThemeController } from './controller.ts'
import { createEndfieldFace } from './endfield-dom.ts'
import { createPushTransport } from '../kit/push/transport.ts'
import type { ThemeFace } from './controller.ts'
import { locale } from './locale.ts'
import type { T } from './locale.ts'

const SettingsPage = lazy(() => import('./views.tsx').then((m) => ({ default: m.SettingsPage })))

function Lazy({ t, children }: { t: T; children: React.ReactNode }) {
  return <Suspense fallback={<div role="status" style={{ padding: 24, color: 'var(--dsw-alias-label-secondary)' }}>{t('panelLoading')}</div>}>{children}</Suspense>
}

export const inject = ['slots', 'locale', 'theme']

export function apply(ctx: Context): void {
  const c = ctx as Context & { locale: Parameters<typeof locale.register>[0]; slots: any; theme: ThemeFace } // eslint-disable-line
  ctx.effect(() => locale.register(c.locale), 'dsh-theme: dictionary')
  const t = locale.bind(c.locale)

  // Live palette: a Typert stream on DSH's single multiplexed WebSocket (never an HTTP stream, which would take one of the
  // browser's 6 connections per host for as long as the page lives).
  const transport = createPushTransport(ctx as never, { pkg: 'dsh-theme', serviceKey: 'dshTheme', namespace: 'dshTheme', streams: [{ method: 'omarchy' }] })
  const controller = new ThemeController({
    open: (signal) => transport.stream('omarchy', [], signal),
    theme: c.theme,
    onThemeChange: (listener) => ctx.on('theme/change' as never, listener as never) as unknown as () => void,
    storage: typeof localStorage === 'undefined' ? undefined : localStorage,
    doc: typeof document === 'undefined' ? undefined : document,
    endfield: typeof document === 'undefined' ? undefined : createEndfieldFace(document),
  })
  // The single revert path: layer, stream and listeners.
  ctx.effect(() => controller.start(), 'dsh-theme: follow/palette layer')

  c.slots.inject('settings.section', () => c.slots.register({
    name: 'settings.section', id: 'dsh-theme', order: 120, label: () => t('nav'),
  }, () => <Lazy t={t}><SettingsPage t={t} controller={controller} /></Lazy>))
}
