/**
 * Browser half. Registers the `.ipynb` right-sidebar tab type and its body. The body (kit, CodeMirror wrapper,
 * output renderers) is a lazy chunk loaded on first open; the boot path only holds this small entry.
 *
 * Why this type wins `.ipynb` clicks over dsh-better-sidebar's editor: the tab registry ranks candidates by
 * priority band, then by the LENGTH of the longest matching pattern, then by registration order. better-sidebar
 * claims `dsh-resource://file/**` (22 chars) in the `extension` band; a bare `*.ipynb` (7 chars) would lose. Our
 * pattern `dsh-resource://file/**\/*.ipynb` (30 chars) is longer, so it wins at equal band. (canOpen re-checks the path.)
 */
import { Suspense, lazy } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import { locale } from './locale.ts'
import { createPushTransport } from '../kit/push/transport.ts'
import type { T } from './locale.ts'

export const TAB_ID = 'dsh-notebook'
export const TAB_KIND = 'notebook'
export const NOTEBOOK_PATTERN = 'dsh-resource://file/**/*.ipynb'

// The entry stays self-contained: the module loader cannot resolve a synchronous require between output files, so
// anything the lazy view also imports must not be imported here. These few address helpers are deliberately inlined.
const FILE_PREFIX = 'dsh-resource://file/session/'
function pathOf(address: string): string | null {
  if (!address.startsWith(FILE_PREFIX)) return null
  const rest = address.slice(FILE_PREFIX.length)
  const slash = rest.indexOf('/')
  if (slash <= 0 || slash === rest.length - 1) return null
  try { return rest.slice(slash + 1).split('/').map((segment) => decodeURIComponent(segment)).join('/') } catch { return null }
}
const isNotebookPath = (path: string): boolean => path.toLowerCase().endsWith('.ipynb')
const titleOf = (address: string): string => {
  const path = pathOf(address)
  const name = path === null ? '' : path.slice(path.lastIndexOf('/') + 1)
  return name === '' ? 'Notebook' : name
}

const NotebookView = lazy(() => import('./view.tsx'))

function Body(props: { sessionId: string; useTabInfo: never; t: T }) {
  return (
    <Suspense fallback={<div role="status" style={{ padding: 16, color: 'var(--dsw-alias-label-secondary)' }}>{props.t('loading')}</div>}>
      <NotebookView {...props} />
    </Suspense>
  )
}

/** Tiny inline icon: the entry must not import modules the lazy view also imports (chunks cannot require each other). */
function TitleIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="2.5" width="10" height="11" rx="1.2" /><path d="M6 2.5v11M8.5 6h2.5M8.5 9h2.5" />
    </svg>
  )
}

function Title({ useTabInfo }: { useTabInfo: () => { tab: { contentId: string } } }) {
  const { tab } = useTabInfo()
  return <><TitleIcon /><span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginLeft: 4 }}>{titleOf(tab.contentId)}</span></>
}

export const inject = ['slots', 'locale', 'sidebarRightTabs']

export function apply(ctx: Context): void {
  const c = ctx as Context & { locale: Parameters<typeof locale.register>[0]; slots: any; sidebarRightTabs: any } // eslint-disable-line
  ctx.effect(() => locale.register(c.locale), 'dsh-notebook: dictionary')
  const t = locale.bind(c.locale)
  // Live notebook events: a Typert stream per open notebook, all on DSH's single multiplexed WebSocket (no HTTP stream;
  // the browser allows only 6 per host). The lazy view reads the opener from shared page state.
  const transport = createPushTransport(ctx as never, { pkg: '@t3labs/ohmydsh-notebook', serviceKey: 'dshNotebook', namespace: 'dshNotebook', streams: [{ method: 'events', params: ['sessionId', 'path'] }] })
  ctx.effect(() => {
    const SHARED = '__dshNotebookStream_v1'
    const bag = ((globalThis as Record<string, unknown>)[SHARED] ??= {}) as { open?: unknown }
    bag.open = (sessionId: string, path: string, signal: AbortSignal) => transport.stream('events', [sessionId, path], signal)
    return () => { bag.open = undefined }
  }, 'dsh-notebook: live stream opener')
  try {
    ctx.effect(() => c.sidebarRightTabs.register({
      id: TAB_ID,
      kind: TAB_KIND,
      patterns: [NOTEBOOK_PATTERN],
      priority: 'extension',
      keepMounted: true,
      multiple: true,
      canOpen: (address: string) => { const path = pathOf(address); return path !== null && isNotebookPath(path) },
      title: (address: string) => titleOf(address),
    }), 'dsh-notebook: tab type')
    ctx.effect(() => c.slots.inject('sidebar.right.pane.tab', () => c.slots.register({
      name: 'sidebar.right.pane.tab', key: TAB_ID, inject: (sessionId: string) => ({ sessionId, t }),
    }, Body)), 'dsh-notebook: tab body')
    ctx.effect(() => c.slots.inject('sidebar.right.pane.tab.title', () => c.slots.register({
      name: 'sidebar.right.pane.tab.title', key: TAB_ID, inject: () => ({}),
    }, Title)), 'dsh-notebook: tab title')
  } catch (error) {
    // A broken notebook tab degrades that tab, never the whole shell boot.
    console.warn('[dsh-notebook] registration failed:', error)
  }
}
