// Client-side types for the v2 host API. Host types are imported with `import type` only (docs/API.md).
import type {
  AssetEdge, AssetRecord, Capability, JobState, MediaKind, ModelDescriptor, Operation, OperationRequest, ParamSpec, ParamValue, ProviderId,
} from '../../v2/contracts.js'

export type { AssetEdge, AssetRecord, Capability, JobState, MediaKind, ModelDescriptor, Operation, OperationRequest, ParamSpec, ParamValue, ProviderId }

/** Job as returned by list/SSE/create (docs/API.md "JobView"). */
export interface JobView {
  id: string
  state: JobState
  op: Operation
  modelId: string
  provider: ProviderId
  createdAt: number
  updatedAt: number
  startedAt?: number
  finishedAt?: number
  progress?: number
  message?: string
  error?: { kind: string; message: string }
  assetIds: string[]
  origin: 'ui' | 'agent' | 'import'
  prompt?: string
  estimateUsd?: number
  costUsd?: number
  costSource?: 'provider' | 'estimate'
  attempt: number
}

export interface EstimateResult {
  ok: boolean
  configured: boolean
  issues: { path: string; message: string }[]
  estimateUsd?: number
  model?: { id: string; label: string; async: 'sync' | 'job' }
}

export interface AssetQuery {
  q?: string
  kind?: MediaKind
  tag?: string
  model?: string
  favorite?: boolean
  /** Only assets that came out of a chat (collected from an agent tool result, or made by a Studio tool inside a session). */
  fromChats?: boolean
  collection?: string
  parent?: string
}

export interface SpendRow { day: string; provider: string; usd: number; count: number }
export interface HfProject { slug: string; dir: string; running: boolean; port?: number; url?: string }
export interface HfStatus { available: boolean; cli?: string; projects: HfProject[] }
export interface HfOpen { slug: string; url: string; port: number; created: boolean; loopbackUrl?: string }
export interface ModelExample { title?: string; summary?: string; pageUrl: string; thumbUrl?: string; input?: Record<string, unknown> }

export const ACTIVE_STATES: readonly JobState[] = ['queued', 'submitting', 'running', 'finalizing']
export const isActive = (state: JobState): boolean => ACTIVE_STATES.includes(state)

export interface AgentMediaSummary { imported: number; alreadyThere: number; skipped: number; failed: number; filesScanned: number; sessionsScanned?: number; at: number }
export interface ChatRef { id: string; title?: string }
