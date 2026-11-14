/**
 * The notebook view (body of the `.ipynb` sidebar tab). State lives in a NotebookStore fed by the host's push
 * channel; this component only renders it and sends intents back. Lazy chunk (kit + CodeMirror wrapper live here).
 */
import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { JSX } from 'react'
import type { UseSidebarRightTabInfo } from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import { Button, EmptyState, IconButton, Modal, Select, TextField } from '../kit/index.ts'
import type { InterpreterOption, WireCell, WireNotebook } from '../core/types.ts'
import { fileOf } from './address.ts'
import { IconClear, IconDown, IconPlay, IconPlus, IconRestart, IconRunAll, IconSave, IconStop, IconTrash, IconUp } from './icons.tsx'
import type { T } from './locale.ts'
import { renderMarkdown, resolveMarkdownImage } from './markdown.ts'
import { MarkdownView } from './markdown-view.tsx'
import { Output } from './outputs.tsx'
import { NotebookStore } from './store.ts'
import cssText from './styles.css?inline'

const CodeEditor = lazy(() => import('./code-editor.tsx'))

function useStyles(): void {
  useEffect(() => {
    const tag = document.createElement('style')
    tag.dataset.nbStyles = ''
    tag.textContent = cssText
    document.head.appendChild(tag)
    return () => tag.remove()
  }, [])
}

export interface ViewProps { sessionId: string; useTabInfo: UseSidebarRightTabInfo; t: T }

const kernelLabel = (nb: WireNotebook, t: T): string => {
  switch (nb.kernel.status) {
    case 'starting': return t('kernelStarting')
    case 'idle': return t('kernelIdle')
    case 'busy': return t('kernelBusy')
    case 'dead': return t('kernelDead')
    case 'error': return t('kernelError')
    default: return t('kernelNone')
  }
}

export default function NotebookView({ sessionId, useTabInfo, t }: ViewProps): JSX.Element {
  useStyles()
  const { tab } = useTabInfo()
  const path = useMemo(() => fileOf(tab.contentId)?.path ?? '', [tab.contentId])
  const store = useMemo(() => new NotebookStore(sessionId, path), [sessionId, path])
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot)
  const nb = state.nb
  const [selected, setSelected] = useState<string | undefined>()
  const [editingMd, setEditingMd] = useState<Set<string>>(new Set())
  const [message, setMessage] = useState<{ text: string; error: boolean } | undefined>()
  const [envOpen, setEnvOpen] = useState(false)
  const [interpreters, setInterpreters] = useState<InterpreterOption[] | undefined>()
  const [confirmRestart, setConfirmRestart] = useState(false)
  const [staleDismissed, setStaleDismissed] = useState(false)
  const readOnly = nb?.readOnly === true
  const kernelRuns = nb?.kernel.runs ?? 0
  // Once something runs on the kernel, a later restart may show the hint again.
  useEffect(() => { if (kernelRuns > 0) setStaleDismissed(false) }, [kernelRuns])

  // Connect while the tab exists; close with it. Hidden tabs stay connected (they are kept mounted) so edits are never missed.
  useEffect(() => {
    if (path === '') return
    store.connect()
    return () => store.close()
  }, [store, path])
  useEffect(() => tab.actions.bindCommands({ refresh: () => void store.reload() }), [tab.actions, store])

  const note = useCallback((text: string, error = false): void => setMessage({ text, error }), [])
  const act = useCallback(async <T2,>(promise: Promise<{ ok: true; value: T2 } | { ok: false; error: { message: string } }>): Promise<void> => {
    const result = await promise
    if (!result.ok) note(result.error.message, true)
  }, [note])

  const cells = nb?.cells ?? []
  const runnable = (c: WireCell): boolean => c.cell_type === 'code' && c.source.trim() !== ''
  const runCells = (ids: string[]): void => { void act(store.run(ids.filter((id) => runnable(cells.find((c) => c.id === id) as WireCell)))) }

  const loadInterpreters = useCallback(async (): Promise<void> => {
    const result = await store.interpreters()
    if (result.ok) setInterpreters(result.value)
  }, [store])
  useEffect(() => { if (envOpen && interpreters === undefined) void loadInterpreters() }, [envOpen, interpreters, loadInterpreters])

  // Ctrl/Cmd+S saves while this tab is the visible one.
  useEffect(() => {
    if (!tab.visible) return
    const onKey = (event: KeyboardEvent): void => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's' && nb !== null) { event.preventDefault(); void act(store.save()) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [tab.visible, nb, store, act])

  if (nb === null) {
    if (state.error !== null && state.connection !== 'reconnecting') return <div className="nb-root"><EmptyState tone="error" title={t('errorTitle')} description={state.error.message} actions={<Button variant="outline" size="sm" onClick={() => store.connect()}>{t('retry')}</Button>} /></div>
    return <div className="nb-root"><div className="nb-empty" role="status">{state.connection === 'reconnecting' ? t('reconnecting') : t('loading')}</div></div>
  }

  const kernelState = nb.kernel.status
  const busy = kernelState === 'busy' || cells.some((c) => c.run !== undefined)
  // Outputs saved by an earlier kernel, but nothing has run on the current (new or restarted) one.
  const hasStale = cells.some((c) => c.cell_type === 'code' && (c.outputs.length > 0 || c.execution_count !== null))
  const staleHint = hasStale && !staleDismissed && !busy && (nb.kernel.runs ?? 0) === 0 && kernelState !== 'starting' && !readOnly
  const selectedIndex = cells.findIndex((c) => c.id === selected)
  const python = nb.python
  const options: { value: string; label: string }[] = [{ value: '', label: t('environmentAuto') }, ...(interpreters ?? (python !== '' ? [{ python, label: python, kind: 'config' as const }] : [])).map((o) => ({ value: o.python, label: `${o.label}${o.ready === undefined ? '' : o.ready ? ` · ${t('environmentReady')}` : ` · ${t('environmentNoKernel')}`}${o.trusted === false ? ` · ${t('environmentUntrusted')}` : ''}` }))]
  if (python !== '' && !options.some((o) => o.value === python)) options.push({ value: python, label: python })

  return (
    <div className="nb-root">
      <div className="nb-toolbar" role="toolbar" aria-label="Notebook">
        <IconButton label={t('save')} icon={<IconSave />} disabled={readOnly || !nb.dirty} onClick={() => void act(store.save())} title={`${t('save')} (Ctrl+S)`} />
        <IconButton label={t('runAll')} icon={<IconRunAll />} disabled={readOnly || cells.length === 0} onClick={() => runCells(cells.map((c) => c.id))} />
        <IconButton label={t('interrupt')} icon={<IconStop />} disabled={!busy} onClick={() => void act(store.interrupt())} />
        <IconButton label={t('restart')} icon={<IconRestart />} disabled={readOnly || kernelState === 'none'} onClick={() => setConfirmRestart(true)} />
        <IconButton label={t('clearOutputs')} icon={<IconClear />} disabled={readOnly || busy} onClick={() => void act(store.edit({ op: 'clear' }))} />
        <Button size="sm" variant="toolbar" disabled={readOnly} onClick={() => void act(store.edit({ op: 'insert', cell_type: 'code', ...selected === undefined ? {} : { after: selected } }))}>{t('addCodeShort')}</Button>
        <Button size="sm" variant="toolbar" disabled={readOnly} onClick={() => void act(store.edit({ op: 'insert', cell_type: 'markdown', ...selected === undefined ? {} : { after: selected } }))}>{t('addMarkdownShort')}</Button>
        <span className="nb-toolbar__spacer" />
        <span className="nb-kernel" title={nb.kernel.python ?? ''}><span className="nb-dot" data-state={kernelState} />{t('kernel')}: {kernelLabel(nb, t)}</span>
        <Button size="sm" variant="outline" onClick={() => setEnvOpen(true)}>{t('environment')}</Button>
      </div>
      {readOnly && <div className="nb-banner nb-banner--info" role="status">{t('readOnly')}</div>}
      {nb.conflict && (
        <div className="nb-banner nb-banner--warn" role="alert">
          <span className="nb-banner__text">{t('conflict')}</span>
          <Button size="sm" variant="outline" onClick={() => void act(store.reload())}>{t('conflictReload')}</Button>
          <Button size="sm" variant="danger" onClick={() => void act(store.save(true))}>{t('conflictOverwrite')}</Button>
        </div>
      )}
      {(kernelState === 'error' || kernelState === 'dead') && nb.kernel.message !== undefined && nb.kernel.message !== '' && (
        <div className="nb-banner nb-banner--error" role="alert"><span className="nb-banner__text">{nb.kernel.message}</span><Button size="sm" variant="outline" onClick={() => setEnvOpen(true)}>{t('environment')}</Button></div>
      )}
      {staleHint && (
        <div className="nb-banner nb-banner--info" role="status">
          <span className="nb-banner__text">{t('staleOutputs')}</span>
          <Button size="sm" variant="outline" onClick={() => runCells(cells.map((c) => c.id))}>{t('rerunAll')}</Button>
          <Button size="sm" variant="ghost" onClick={() => setStaleDismissed(true)}>{t('dismiss')}</Button>
        </div>
      )}
      {state.connection === 'reconnecting' && <div className="nb-banner nb-banner--info" role="status">{t('reconnecting')}</div>}
      {message !== undefined && <div className={`nb-banner ${message.error ? 'nb-banner--error' : 'nb-banner--info'}`} role={message.error ? 'alert' : 'status'}><span className="nb-banner__text">{message.text}</span><Button size="sm" variant="ghost" onClick={() => setMessage(undefined)}>×</Button></div>}

      {cells.length === 0 ? (
        <EmptyState title={t('emptyNotebook')} actions={!readOnly ? <><Button size="sm" variant="outline" onClick={() => void act(store.edit({ op: 'insert', cell_type: 'code' }))}>{t('addCode')}</Button><Button size="sm" variant="outline" onClick={() => void act(store.edit({ op: 'insert', cell_type: 'markdown' }))}>{t('addMarkdown')}</Button></> : undefined} />
      ) : (
        <div className="nb-cells" onKeyDown={(event) => {
          // Command-style shortcuts only when focus is not inside an editor.
          const target = event.target as HTMLElement
          if (target.closest('.nb-editor, textarea, input, select') !== null || selected === undefined || readOnly) return
          if (event.key === 'ArrowDown' && selectedIndex < cells.length - 1) { event.preventDefault(); setSelected(cells[selectedIndex + 1]?.id) }
          else if (event.key === 'ArrowUp' && selectedIndex > 0) { event.preventDefault(); setSelected(cells[selectedIndex - 1]?.id) }
        }}>
          {cells.map((cell, index) => (
            <CellView
              key={cell.id} cell={cell} index={index} total={cells.length} t={t} store={store} readOnly={readOnly}
              selected={selected === cell.id} agent={state.agentTouched[cell.id] !== undefined}
              editingMd={editingMd.has(cell.id) || (cell.cell_type === 'markdown' && cell.source === '')}
              notebookPath={nb.path}
              onSelect={() => setSelected(cell.id)}
              onToggleMd={() => setEditingMd((prev) => { const next = new Set(prev); if (next.has(cell.id)) next.delete(cell.id); else next.add(cell.id); return next })}
              onRun={(advance) => { runCells([cell.id]); if (advance) { const nextCell = cells[index + 1]; if (nextCell !== undefined) setSelected(nextCell.id); else void act(store.edit({ op: 'insert', after: cell.id, cell_type: 'code' })) } }}
              onRunAbove={() => runCells(cells.slice(0, index).map((c) => c.id))}
              onRunBelow={() => runCells(cells.slice(index).map((c) => c.id))}
              act={act}
            />
          ))}
          {!readOnly && <div className="nb-add"><Button size="sm" variant="outline" icon={<IconPlus />} onClick={() => void act(store.edit({ op: 'insert', cell_type: 'code', after: cells[cells.length - 1]?.id as string }))}>{t('addCodeShort')}</Button><Button size="sm" variant="outline" icon={<IconPlus />} onClick={() => void act(store.edit({ op: 'insert', cell_type: 'markdown', after: cells[cells.length - 1]?.id as string }))}>{t('addMarkdownShort')}</Button></div>}
        </div>
      )}

      <EnvDialog
        open={envOpen} onClose={() => setEnvOpen(false)} t={t} options={options} python={python} readOnly={readOnly} kernel={nb.kernel}
        onPick={(value) => void act(store.setPython(value))}
        onRescan={() => { setInterpreters(undefined); void loadInterpreters() }}
        onCreate={async (packages) => {
          const result = await store.createEnv(packages)
          if (result.ok) { note(t('createEnvDone')); setInterpreters(undefined) } else note(result.error.message, true)
          return result.ok
        }}
      />
      <Modal open={confirmRestart} onClose={() => setConfirmRestart(false)} title={t('restart')} closeLabel="Close" description={t('restartConfirm')}
        footer={<><Button variant="outline" onClick={() => setConfirmRestart(false)}>Cancel</Button><Button variant="danger" data-modal-autofocus onClick={() => { setConfirmRestart(false); void act(store.restart()) }}>{t('restart')}</Button></>} />
    </div>
  )
}

interface CellViewProps {
  cell: WireCell; index: number; total: number; t: T; store: NotebookStore; readOnly: boolean
  selected: boolean; agent: boolean; editingMd: boolean; notebookPath: string
  onSelect: () => void; onToggleMd: () => void; onRun: (advance: boolean) => void; onRunAbove: () => void; onRunBelow: () => void
  act: <T2,>(promise: Promise<{ ok: true; value: T2 } | { ok: false; error: { message: string } }>) => Promise<void>
}

function CellView(p: CellViewProps): JSX.Element {
  const { cell, t, store, readOnly } = p
  const isCode = cell.cell_type === 'code'
  const isMd = cell.cell_type === 'markdown'
  const running = cell.run !== undefined
  const latestSource = useRef(cell.source)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const [draft, setDraft] = useState<string | undefined>()
  const shown = draft ?? cell.source

  // A remote change replaces a draft that no longer differs from the host's value.
  useEffect(() => { latestSource.current = cell.source; if (draft !== undefined && draft === cell.source) setDraft(undefined) }, [cell.source, draft])
  useEffect(() => () => { if (timer.current !== undefined) clearTimeout(timer.current) }, [])

  const commit = useCallback((value: string): void => {
    setDraft(value)
    if (timer.current !== undefined) clearTimeout(timer.current)
    timer.current = setTimeout(() => { void store.edit({ op: 'source', id: cell.id, source: value }); }, 250)
  }, [store, cell.id])
  const flush = (): void => { if (timer.current !== undefined) { clearTimeout(timer.current); timer.current = undefined; if (draft !== undefined && draft !== cell.source) void store.edit({ op: 'source', id: cell.id, source: draft }) } }

  const md = useMemo(() => (isMd ? renderMarkdown(cell.source, { resolveImageSrc: (src) => {
    if (src.startsWith('attachment:')) {
      const name = src.slice('attachment:'.length)
      const bundle = (cell.attachments?.[name] ?? undefined) as Record<string, unknown> | undefined
      const mime = bundle === undefined ? undefined : ['image/png', 'image/jpeg', 'image/gif', 'image/webp'].find((m) => typeof bundle[m] === 'string')
      return mime === undefined || bundle === undefined ? null : `data:${mime};base64,${String(bundle[mime]).replace(/\s+/g, '')}`
    }
    const r = resolveMarkdownImage(p.notebookPath, src)
    return r.kind === 'absolute' ? src : r.kind === 'escape' ? null : store.rawUrl(r.path)
  } }) : ''), [isMd, cell.source, cell.attachments, p.notebookPath, store])

  const counter = isCode ? (running ? (cell.run === 'queued' ? '[ ]' : '[*]') : cell.execution_count === null ? '[ ]' : `[${cell.execution_count}]`) : ''

  return (
    <div className="nb-cell" data-selected={p.selected} data-agent={p.agent} data-cell-id={cell.id} onClick={p.onSelect} onFocus={p.onSelect}>
      <div className="nb-cell__gutter">
        {isCode && <span className="nb-cell__count">{running ? <span className="nb-spinner" role="status" aria-label={t('kernelBusy')} /> : counter}</span>}
        {isCode && <IconButton label={running ? t('interrupt') : t('run')} icon={running ? <IconStop /> : <IconPlay />} disabled={readOnly && !running} onClick={() => (running ? void p.act(store.interrupt()) : (flush(), p.onRun(false)))} />}
      </div>
      <div className="nb-cell__main">
        {!readOnly && (
          <div className="nb-cell__bar" role="toolbar" aria-label={`Cell ${p.index + 1}`}>
            {isCode && <IconButton label={t('runAbove')} icon={<IconRunAll />} onClick={p.onRunAbove} />}
            <IconButton label={t('moveUp')} icon={<IconUp />} disabled={p.index === 0} onClick={() => void p.act(store.edit({ op: 'move', id: cell.id, to: p.index - 1 }))} />
            <IconButton label={t('moveDown')} icon={<IconDown />} disabled={p.index === p.total - 1} onClick={() => void p.act(store.edit({ op: 'move', id: cell.id, to: p.index + 1 }))} />
            <Button size="sm" variant="ghost" onClick={() => void p.act(store.edit({ op: 'type', id: cell.id, cell_type: isCode ? 'markdown' : 'code' }))}>{isCode ? t('toMarkdown') : t('toCode')}</Button>
            <IconButton label={t('addCode')} icon={<IconPlus />} onClick={() => void p.act(store.edit({ op: 'insert', after: cell.id, cell_type: 'code' }))} />
            <IconButton label={t('deleteCell')} icon={<IconTrash />} disabled={running} onClick={() => void p.act(store.edit({ op: 'delete', id: cell.id }))} />
          </div>
        )}
        {isMd && !p.editingMd ? (
          cell.source.trim() === '' ? <div className="nb-md nb-md--empty" onDoubleClick={() => !readOnly && p.onToggleMd()}>{t('emptyMarkdown')}</div> : <MarkdownView html={md} className="nb-md" onDoubleClick={() => !readOnly && p.onToggleMd()} />
        ) : (
          <Suspense fallback={<textarea className="nb-plain" readOnly value={shown} rows={Math.min(12, shown.split('\n').length)} />}>
            <CodeEditor
              value={shown} language={isCode ? 'python' : isMd ? 'markdown' : 'plain'} readOnly={readOnly} lineNumbers={isCode}
              onChange={commit} onFocus={p.onSelect}
              onRun={() => { flush(); if (isMd) p.onToggleMd(); else p.onRun(true) }}
              onRunStay={() => { flush(); if (isMd) p.onToggleMd(); else p.onRun(false) }}
            />
          </Suspense>
        )}
        {isCode && cell.outputs.length > 0 && (
          <div className="nb-outputs">{cell.outputs.map((output, i) => <Output key={i} output={output} t={t} />)}</div>
        )}
      </div>
    </div>
  )
}

function EnvDialog(props: {
  open: boolean; onClose: () => void; t: T; options: { value: string; label: string }[]; python: string; readOnly: boolean
  kernel: WireNotebook['kernel']; onPick: (python: string) => void; onRescan: () => void; onCreate: (packages: string[]) => Promise<boolean>
}): JSX.Element {
  const { t } = props
  const [packages, setPackages] = useState('pandas matplotlib')
  const [busy, setBusy] = useState(false)
  return (
    <Modal open={props.open} onClose={props.onClose} title={t('environment')} closeLabel="Close" {...props.kernel.python === undefined ? {} : { description: props.kernel.python }}
      footer={<Button variant="outline" onClick={props.onClose}>Close</Button>}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <Select label={t('environment')} options={props.options} value={props.python} disabled={props.readOnly} onChange={props.onPick} />
        <div><Button size="sm" variant="ghost" onClick={props.onRescan}>{t('environmentRefresh')}</Button></div>
        {!props.readOnly && (
          <>
            <TextField label={t('createEnvPackages')} value={packages} onChange={(e) => setPackages(e.target.value)} disabled={busy} />
            <div><Button size="sm" variant="primary" disabled={busy} onClick={() => { setBusy(true); void props.onCreate(packages.split(/\s+/).filter(Boolean)).catch(() => false).finally(() => setBusy(false)) }}>{busy ? t('createEnvBusy') : t('createEnv')}</Button></div>
          </>
        )}
      </div>
    </Modal>
  )
}
