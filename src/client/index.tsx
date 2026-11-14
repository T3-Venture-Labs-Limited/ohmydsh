// Browser half. Light on the boot path: the action button and the settings page are one lazy chunk (views.tsx).
// Contributions use ctx.slots.inject(...) so they wait for the declaring package and leave with this plugin.
import { Suspense, lazy } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import { locale } from './locale.ts'
import { createFace } from './trace-link.ts'
import type { Face, Rpc } from './trace-link.ts'

const SettingsPage = lazy(() => import('./views.tsx').then((m) => ({ default: m.SettingsPage })))
const OpenTraceAction = lazy(() => import('./views.tsx').then((m) => ({ default: m.OpenTraceAction })))

export const inject = ['slots', 'locale', 'connection']

interface ActionProps { messageId: string; sessionId?: string; face: Face; t: ReturnType<typeof locale.bind> }

export function apply(ctx: Context): void {
  const c = ctx as Context & { locale: Parameters<typeof locale.register>[0]; slots: any; connection: { rpc: Rpc } } // eslint-disable-line
  ctx.effect(() => locale.register(c.locale), 'dsh-langfuse: dictionary')
  const t = locale.bind(c.locale)
  const face = createFace(c.connection.rpc)

  c.slots.inject('settings.section', () => c.slots.register({
    name: 'settings.section', id: 'dsh-langfuse', order: 120, label: () => t('nav'),
  }, () => <Suspense fallback={null}><SettingsPage t={t} face={face} /></Suspense>))

  // "Open trace" under every finalized assistant message. The session id comes from the injected business face.
  c.slots.inject('conversation.chat.assistant-actions', () => c.slots.register({
    name: 'conversation.chat.assistant-actions',
    id: 'dsh-langfuse-open-trace',
    order: 40,
    inject: (sessionId: string) => ({ sessionId }),
  }, (props: ActionProps) => (
    <Suspense fallback={null}><OpenTraceAction messageId={String(props.messageId)} sessionId={String(props.sessionId ?? '')} face={face} t={t} /></Suspense>
  )))
}
