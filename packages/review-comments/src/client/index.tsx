// Client entry. Everything is registered inside ctx.effect so disabling the plugin removes all of it.
import { createRoot } from 'react-dom/client'
import type { Ctx } from './host.ts'
import { locale, bindLocale, unbindLocale } from './locale.ts'
import { createCommentStore } from './store.ts'
import { createSelectionController } from './selection.ts'
import { Overlay } from './ui/Overlay.tsx'
import { createDock } from './ui/Dock.tsx'
import { createReviewTab } from './ui/ReviewTab.tsx'
import { IconComment } from './ui/icons.tsx'
import { uiState } from './ui-state.ts'
import { DOCK_ID, TAB_IMPL, TAB_KIND } from './constants.ts'
import { t } from './locale.ts'
import { runtime } from './runtime.ts'
import { startHostSync } from './hostSync.ts'
import { createPushTransport } from '../kit/push/transport.ts'

export const name = '@t3labs/ohmydsh-review-comments'
export const inject = ['slots', 'locale', 'sessions', 'conversation']

interface TabRegistry {
  register(def: Record<string, unknown>): () => void
}

export function apply(ctx: Ctx): void {
  const store = createCommentStore()
  ctx.effect(() => { const off = locale.register(ctx.locale); bindLocale(ctx.locale); return () => { off(); unbindLocale() } }, 'dsh-review-comments: dictionary')
  ctx.effect(() => { runtime.set(ctx); return () => { runtime.set(undefined) } }, 'dsh-review-comments: runtime')
  // Live channel: a Typert stream on DSH's single multiplexed WebSocket (no HTTP stream; the browser allows only 6 per host).
  const transport = createPushTransport(ctx as never, { pkg: '@t3labs/ohmydsh-review-comments', serviceKey: 'dshReviewComments', namespace: 'dshReviewComments', streams: [{ method: 'changes' }] })
  ctx.effect(() => { const sync = startHostSync(store, { fetch: globalThis.fetch.bind(globalThis), open: (signal) => transport.stream('changes', [], signal) }); return () => { sync.dispose() } }, 'dsh-review-comments: host sync')
  ctx.effect(() => () => { store.dispose(); uiState.reset() }, 'dsh-review-comments: store')

  // Selection pipeline + floating layer. Mounted in shell.overlay (frame-wide, click-through; our layer opts back in).
  ctx.effect(() => {
    const controller = createSelectionController(ctx)
    const Layer = (): JSX.Element => <Overlay ctx={ctx} controller={controller} store={store} />
    const off = ctx.slots.inject('shell.overlay', () => ctx.slots.register({ name: 'shell.overlay', id: 'dsh-review-comments', order: 50 }, Layer))
    return () => { controller.dispose(); off() }
  }, 'dsh-review-comments: overlay')

  // "N comments · Send to composer" above the composer.
  ctx.effect(() => ctx.slots.inject('conversation.input.dock', () => ctx.slots.register(
    { name: 'conversation.input.dock', id: DOCK_ID, order: 20 }, createDock(ctx, store))), 'dsh-review-comments: dock')

  // Review tab type. The registry service arrives after the slot declarations, so wait for the service itself.
  ctx.inject(['sidebarRightTabs'], (injected) => {
    const tabs = injected.get('sidebarRightTabs') as TabRegistry | undefined
    if (tabs === undefined) return
    const disposeType = tabs.register({
      id: TAB_IMPL, kind: TAB_KIND, keepMounted: true, priority: 'extension',
      title: () => t('tabTitle'),
      guide: [{ id: 'review', order: 70, title: () => t('tabGuide'), icon: (props: { size?: number }) => <IconComment size={props.size ?? 16} /> }],
    })
    const disposeBody = ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({ name: 'sidebar.right.pane.tab', key: TAB_IMPL }, createReviewTab(ctx, store)))
    return () => { disposeBody(); disposeType() }
  })
}

// Mount helper kept for tests: render an element tree into a detached host.
export function mount(element: JSX.Element): () => void {
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  root.render(element)
  return () => { root.unmount(); host.remove() }
}
