// Live state: jobs (initial load, then a Typert push stream; a slow poll only while the stream is unavailable) and the model catalog.
import { useEffect, useMemo } from 'react'
import { api } from './api.js'
import { createStore, useStore } from './store.js'
import { subscribePush } from '../../kit/push/client.js'
import type { PushEnv } from '../../kit/push/client.js'
import { sharedState } from '../shared-state.js'
import { isActive, type AssetRecord, type JobView, type ModelDescriptor } from './types.js'

interface LiveState { jobs: Record<string, JobView>; connected: boolean; loaded: boolean }
export const liveStore = createStore<LiveState>({ jobs: {}, connected: false, loaded: false })

const assetListeners = new Set<(asset: AssetRecord) => void>()
export function onAsset(listener: (asset: AssetRecord) => void): () => void {
  assetListeners.add(listener)
  return () => { assetListeners.delete(listener) }
}
const doneListeners = new Set<(job: JobView) => void>()
/** Fires when a job reaches a terminal state (once per transition). */
export function onJobDone(listener: (job: JobView) => void): () => void {
  doneListeners.add(listener)
  return () => { doneListeners.delete(listener) }
}

function putJob(job: JobView): void {
  const previous = liveStore.get().jobs[job.id]
  liveStore.set(state => ({ ...state, jobs: { ...state.jobs, [job.id]: job } }))
  if (previous !== undefined && isActive(previous.state) && !isActive(job.state) && job.state !== 'needs_attention') for (const l of doneListeners) l(job)
}
export function upsertJob(job: JobView): void { putJob(job) }
export function dismissJobs(ids: readonly string[]): void {
  liveStore.set(state => {
    const jobs = { ...state.jobs }
    for (const id of ids) delete jobs[id]
    return { ...state, jobs }
  })
}

/** Where the boot bundle leaves the stream opener (the lazy workbench chunk cannot import the gateway transport itself). */
export interface LivePush { open?: ((signal: AbortSignal) => AsyncIterable<unknown>) | undefined; env?: PushEnv | undefined }
const livePush = sharedState<LivePush>('livePush', () => ({}))
export const LIVE_STREAM_ID = 'dsh-studio:jobs'
export const FALLBACK_POLL_MS = 15_000
/** Test seam / boot hook: wire the stream opener. */
export function configureLive(open: LivePush['open'], env?: PushEnv): void { livePush.open = open; livePush.env = env }

let holders = 0
let release: (() => void) | undefined
let closeTimer: ReturnType<typeof setTimeout> | undefined

function mergeJobs(jobs: readonly JobView[]): void {
  liveStore.set(state => {
    const merged = { ...state.jobs }
    for (const job of jobs) if (merged[job.id] === undefined || merged[job.id]!.updatedAt <= job.updatedAt) merged[job.id] = job
    return { ...state, jobs: merged, loaded: true }
  })
}
const loadJobs = (): Promise<void> => api.jobs({ limit: 40 }).then(({ jobs }) => { mergeJobs(jobs) }).catch(() => { liveStore.set(state => ({ ...state, loaded: true })) })

function onFrame(frame: unknown): void {
  const f = frame as { event?: string; data?: unknown } | null
  if (f === null || typeof f !== 'object') return
  try {
    if (f.event === 'snapshot') for (const job of (f.data as { jobs: JobView[] }).jobs) putJob(job)
    else if (f.event === 'job') putJob(f.data as JobView)
    else if (f.event === 'asset') for (const l of assetListeners) l(f.data as AssetRecord)
  } catch { /* ignore a malformed frame */ }
}

/** Join the shared stream: it is a Typert stream on DSH's one WebSocket, open only while a surface is mounted and the page is visible. */
function open(): void {
  if (release !== undefined) return
  const stream = livePush.open
  if (stream === undefined) { void loadJobs(); return }
  release = subscribePush<unknown>({
    id: LIVE_STREAM_ID,
    replay: false,
    open: stream,
    // (Re)opened after being closed (hidden tab, reconnect): reload the list, the stream then keeps it current.
    onOpen: () => { liveStore.set(state => ({ ...state, connected: true })); void loadJobs() },
    onClose: () => { liveStore.set(state => ({ ...state, connected: false })) },
    // While the stream cannot be opened, a slow poll keeps the list fresh.
    poll: loadJobs,
    pollMs: FALLBACK_POLL_MS,
  }, onFrame, livePush.env)
}

/** Hold the live channel open while a surface is mounted. */
export function retainLive(): () => void {
  holders++
  if (closeTimer !== undefined) { clearTimeout(closeTimer); closeTimer = undefined }
  open()
  return () => {
    holders--
    if (holders > 0) return
    closeTimer = setTimeout(() => { if (holders === 0) { release?.(); release = undefined; liveStore.set(state => ({ ...state, connected: false })) } }, 5000)
  }
}

export function useLive(): LiveState {
  useEffect(() => retainLive(), [])
  const jobs = useStore(liveStore, s => s.jobs)
  const connected = useStore(liveStore, s => s.connected)
  const loaded = useStore(liveStore, s => s.loaded)
  return useMemo(() => ({ jobs, connected, loaded }), [jobs, connected, loaded])
}

export function sortedJobs(jobs: Record<string, JobView>): JobView[] {
  return Object.values(jobs).sort((a, b) => {
    const active = Number(isActive(b.state) || b.state === 'needs_attention') - Number(isActive(a.state) || a.state === 'needs_attention')
    return active !== 0 ? active : b.updatedAt - a.updatedAt
  })
}

/* ---------------- models ---------------- */
interface ModelsState { status: 'idle' | 'loading' | 'ready' | 'error'; models: ModelDescriptor[]; configured: Record<string, boolean>; error?: string }
export const modelsStore = createStore<ModelsState>({ status: 'idle', models: [], configured: {} })

export async function loadModels(refresh = false): Promise<void> {
  const state = modelsStore.get()
  if (state.status === 'loading' || (state.status === 'ready' && !refresh)) return
  modelsStore.set({ ...state, status: 'loading' })
  try {
    const [models, providers] = await Promise.all([api.models({ refresh }), api.providers()])
    modelsStore.set({ status: 'ready', models: models.models, configured: Object.fromEntries(providers.providers.map(p => [p.id, p.configured])) })
  } catch (error) {
    modelsStore.set({ status: 'error', models: state.models, configured: state.configured, error: error instanceof Error ? error.message : String(error) })
  }
}

export function useModels(): ModelsState {
  useEffect(() => { void loadModels() }, [])
  const status = useStore(modelsStore, s => s.status)
  const models = useStore(modelsStore, s => s.models)
  const configured = useStore(modelsStore, s => s.configured)
  const error = useStore(modelsStore, s => s.error)
  return useMemo(() => ({ status, models, configured, ...(error === undefined ? {} : { error }) }), [status, models, configured, error])
}

/** Label lookup for any model id (falls back to the remote part of the id). */
export function labelOf(id: string): string {
  return modelsStore.get().models.find(m => m.id === id)?.label ?? (id.includes(':') ? id.slice(id.indexOf(':') + 1) : id)
}
