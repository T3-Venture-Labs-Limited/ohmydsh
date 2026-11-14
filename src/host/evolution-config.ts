// Evolution settings: UI-editable, DSH-only (config.json beside settings.json). Defaults are conservative: the reviewer is off
// until the user turns it on (it sends redacted transcript excerpts to the chosen model provider).
// Default route: the same cheap-but-capable route used for other automations (Sonnet, low effort).
export interface ProposeConfig { enabled: boolean; maxPendingPerSession: number; maxPending: number }
export interface ReviewerConfig {
  enabled: boolean
  /** Route used when dsh-automation-models is absent or has no override for source `skill-reviewer`. */
  provider: string
  model: string
  effort: string
  idleMinutes: number
  dailySweep: boolean
  minUserTurns: number
  minToolCalls: number
  maxSessionsPerRun: number
  maxInputChars: number
  maxOutputTokens: number
  maxTokensPerDay: number
  /** A candidate seen in only one session needs at least this confidence. */
  singleSessionConfidence: number
  excludeCwds: string[]
  timeoutMs: number
}
export type ApproveTarget = 'user-agents' | 'user-dsh' | 'project-agents' | 'project-dsh'
export interface EvolutionConfig { version: 1; approveTarget: ApproveTarget; propose: ProposeConfig; reviewer: ReviewerConfig }

export const DEFAULT_CONFIG: EvolutionConfig = {
  version: 1,
  approveTarget: 'user-agents',
  propose: { enabled: true, maxPendingPerSession: 3, maxPending: 20 },
  reviewer: {
    enabled: false, provider: 'claude', model: 'claude-sonnet-5-5', effort: 'low', idleMinutes: 20, dailySweep: true,
    minUserTurns: 3, minToolCalls: 4, maxSessionsPerRun: 8, maxInputChars: 48_000, maxOutputTokens: 6000, maxTokensPerDay: 300_000,
    singleSessionConfidence: 0.8, excludeCwds: [], timeoutMs: 120_000,
  },
}

const TARGETS: ApproveTarget[] = ['user-agents', 'user-dsh', 'project-agents', 'project-dsh']
const num = (v: unknown, d: number, min: number, max: number): number => (typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, Math.round(v * 100) / 100)) : d)
const str = (v: unknown, d: string): string => (typeof v === 'string' && v.trim().length > 0 ? v.trim() : d)
const bool = (v: unknown, d: boolean): boolean => (typeof v === 'boolean' ? v : d)

export function normalizeConfig(input: unknown): EvolutionConfig {
  const r = (typeof input === 'object' && input !== null ? input : {}) as Record<string, Record<string, unknown> | string | number>
  const p = (typeof r.propose === 'object' && r.propose !== null ? r.propose : {}) as Record<string, unknown>
  const v = (typeof r.reviewer === 'object' && r.reviewer !== null ? r.reviewer : {}) as Record<string, unknown>
  const d = DEFAULT_CONFIG
  return {
    version: 1,
    approveTarget: TARGETS.includes(r.approveTarget as ApproveTarget) ? (r.approveTarget as ApproveTarget) : d.approveTarget,
    propose: {
      enabled: bool(p.enabled, d.propose.enabled), maxPendingPerSession: num(p.maxPendingPerSession, d.propose.maxPendingPerSession, 1, 20), maxPending: num(p.maxPending, d.propose.maxPending, 1, 200),
    },
    reviewer: {
      enabled: bool(v.enabled, d.reviewer.enabled), provider: str(v.provider, d.reviewer.provider), model: str(v.model, d.reviewer.model), effort: str(v.effort, d.reviewer.effort),
      idleMinutes: num(v.idleMinutes, d.reviewer.idleMinutes, 0.1, 1440), dailySweep: bool(v.dailySweep, d.reviewer.dailySweep),
      minUserTurns: num(v.minUserTurns, d.reviewer.minUserTurns, 0, 100), minToolCalls: num(v.minToolCalls, d.reviewer.minToolCalls, 0, 1000),
      maxSessionsPerRun: num(v.maxSessionsPerRun, d.reviewer.maxSessionsPerRun, 1, 50), maxInputChars: num(v.maxInputChars, d.reviewer.maxInputChars, 4000, 200_000),
      maxOutputTokens: num(v.maxOutputTokens, d.reviewer.maxOutputTokens, 500, 32_000), maxTokensPerDay: num(v.maxTokensPerDay, d.reviewer.maxTokensPerDay, 1000, 10_000_000),
      singleSessionConfidence: num(v.singleSessionConfidence, d.reviewer.singleSessionConfidence, 0, 1), timeoutMs: num(v.timeoutMs, d.reviewer.timeoutMs, 5000, 600_000),
      excludeCwds: Array.isArray(v.excludeCwds) ? v.excludeCwds.filter((x): x is string => typeof x === 'string' && x.length > 0) : [],
    },
  }
}
