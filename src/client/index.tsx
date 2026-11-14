// Browser half. A UI-less bridge (notification clicks, share drafts) plus one Settings section for phone notifications.
// The installable app itself is the normal DSH UI, served by the host half (manifest, service worker, /share, /push).
import { Suspense, lazy } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import { locale } from './locale.ts'
import { startBridge, type ShareRecord } from './bridge.ts'

const SettingsPage = lazy(() => import('./views.tsx').then((m) => ({ default: m.SettingsPage })))

function Lazy({ children }: { children: React.ReactNode }) {
  return <Suspense fallback={<div role="status" style={{ padding: 24, color: 'var(--dsw-alias-label-secondary)' }}>…</div>}>{children}</Suspense>
}

export const inject = ['slots', 'locale']

interface Snapshot<T> { getSnapshot(): T; subscribe(fn: () => void): () => void }
interface UiWorkspaceLike {
  openSession(id: string): void
  startSession(workspaceId?: string, options?: { prompt?: string; whenDraftExists?: 'replace' | 'append' | 'keep' }): void
}

/** Resolves true once the session and workspace lists are loaded (so navigation has something to act on), false after a timeout. */
function listsReady(sessions: Snapshot<{ phase?: string }>, workspaces: Snapshot<{ phase?: string }>, timeoutMs = 20_000): Promise<boolean> {
  const ready = (): boolean => sessions.getSnapshot().phase === 'ready' && workspaces.getSnapshot().phase === 'ready'
  if (ready()) return Promise.resolve(true)
  return new Promise((resolve) => {
    const offs: (() => void)[] = []
    const done = (value: boolean): void => { offs.forEach((off) => off()); clearTimeout(timer); resolve(value) }
    const timer = setTimeout(() => done(false), timeoutMs)
    const check = (): void => { if (ready()) done(true) }
    offs.push(sessions.subscribe(check), workspaces.subscribe(check))
  })
}

export function apply(ctx: Context): void {
  const c = ctx as Context & { locale: Parameters<typeof locale.register>[0]; slots: any } // eslint-disable-line
  ctx.effect(() => locale.register(c.locale), 'dsh-pwa: dictionary')
  const t = locale.bind(c.locale)

  c.slots.inject('settings.section', () => c.slots.register({
    name: 'settings.section', id: 'dsh-pwa', order: 130, label: () => t('nav'),
  }, () => <Lazy><SettingsPage t={t} /></Lazy>))

  // Notification clicks and share drafts need the workspace navigation service; without it the section above still works.
  ;(ctx as unknown as { inject(names: string[], fn: (scope: { get(name: string): unknown }) => void | (() => void)): void }).inject(['sessions', 'workspaces', 'uiWorkspace'], (scope) => {
    const sessions = scope.get('sessions') as { list: Snapshot<{ phase?: string; current?: unknown }> }
    const workspaces = scope.get('workspaces') as { list: Snapshot<{ phase?: string }> }
    const ui = scope.get('uiWorkspace') as UiWorkspaceLike
    return startBridge({
      openSession: (id) => { ui.openSession(id) },
      startDraft: (prompt) => { ui.startSession(undefined, { prompt, whenDraftExists: 'append' }) },
      currentSessionId: () => {
        // Same two sources dsh-review-comments uses: the list snapshot's current id, else the conversation DOM marker.
        const current = sessions.list.getSnapshot().current
        if (typeof current === 'string' && current !== '') return current
        return document.querySelector<HTMLElement>('[data-conversation-session]')?.dataset['conversationSession'] ?? ''
      },
      location: window.location,
      replaceUrl: (url) => { window.history.replaceState(window.history.state, '', url) },
      fetchShare: async (id): Promise<ShareRecord | undefined> => {
        try {
          const response = await fetch(`/share?id=${encodeURIComponent(id)}`, { credentials: 'same-origin', cache: 'no-store' })
          if (!response.ok) return undefined
          return ((await response.json()) as { share?: ShareRecord }).share
        } catch { return undefined }
      },
      isShareableReady: () => listsReady(sessions.list, workspaces.list),
      worker: 'serviceWorker' in navigator ? navigator.serviceWorker : undefined,
    })
  })
}
