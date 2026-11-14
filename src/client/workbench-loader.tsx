/**
 * Boot-side handle for the lazy workbench chunk (gallery, composer, styles, HyperFrames, lightbox, tool cards).
 * tsdown rewrites the dynamic import below into the module loader's `require.async("./client.workbench.js")`;
 * nothing from the workbench is in client.js, so the boot payload stays small.
 */
import { lazy, Suspense, type ComponentType, type ReactElement } from 'react'
import type * as WorkbenchModule from './workbench/index.js'
import type { StudioTab } from './studio-bus.js'

type Workbench = typeof WorkbenchModule
let loading: Promise<Workbench> | undefined

export function loadWorkbench(): Promise<Workbench> {
  loading ??= import('./client.workbench.js' as string).then((module: Workbench) => module, (error: unknown) => {
    loading = undefined
    throw error
  })
  return loading
}

const LazyStudio = lazy(() => loadWorkbench().then(m => ({ default: m.StudioWorkbench as ComponentType<WorkbenchModule.WorkbenchProps> })))
const LazyToolCardInner = lazy(() => loadWorkbench().then(m => ({ default: m.StudioToolCard as ComponentType<{ data: WorkbenchModule.ToolCardData }> })))

const Loading = (): ReactElement => <div style={{ padding: 16, color: 'var(--dsw-alias-label-secondary)', fontSize: 13 }} role="status">Loading Studio…</div>

export function StudioSurface({ inSidebar, initialTab }: { inSidebar: boolean; initialTab?: StudioTab }): ReactElement {
  return (
    <Suspense fallback={<Loading />}>
      <LazyStudio inSidebar={inSidebar} {...(initialTab === undefined ? {} : { initialTab })} />
    </Suspense>
  )
}

interface ToolBlock {
  phase?: string
  kind?: string
  name?: string
  args?: unknown
  argsRaw?: string
  content?: ReadonlyArray<{ type: string; text?: string }>
  isError?: boolean
}

/** Tool view for studio_make / studio_job / studio_gallery. Shows the result text only through the card. */
export function StudioToolView(props: { toolName: string; phase: 'preparing' | 'start' | 'result'; block: unknown }): ReactElement {
  const block = props.block as ToolBlock
  const text = (block.content ?? []).filter(c => c.type === 'text').map(c => c.text ?? '').join('\n')
  let args: Record<string, unknown> = {}
  if (typeof block.argsRaw === 'string') { try { args = JSON.parse(block.argsRaw) as Record<string, unknown> } catch { /* partial */ } }
  return (
    <Suspense fallback={<Loading />}>
      <LazyToolCardInner data={{ toolName: props.toolName, phase: props.phase, text, isError: block.isError === true, args }} />
    </Suspense>
  )
}
