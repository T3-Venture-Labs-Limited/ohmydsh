// Proposal queue: the single source of truth for skills the agent or the reviewer suggests. NOTHING in this module writes skill files:
// `decide()` returns what to write and the caller (the approve route) hands it to writer.ts. Tools and the reviewer only ever call `enqueue()`.
import { createHash, randomUUID } from 'node:crypto'
import { containsSecret } from './redact.ts'
import { closestSkills, type Closest } from './dedupe.ts'
import { unifiedDiff, type DiffStats } from './diff.ts'
import { validateSkillText, SKILL_NAME, BODY_SOFT_BYTES, type Issue } from './frontmatter.ts'

export type ProposalKind = 'new' | 'improve'
export type ProposalStatus = 'pending' | 'approved' | 'edited-approved' | 'rejected' | 'stale' | 'failed'
export interface Evidence { sessionId: string; turn?: number; quote?: string }
export interface Origin { kind: 'tool' | 'reviewer'; sessionId?: string; callId?: string; runId?: string }

export interface Proposal {
  id: string
  createdAt: number
  origin: Origin
  kind: ProposalKind
  name: string
  rationale: string
  evidence: Evidence[]
  /** Full SKILL.md text proposed (for an improvement, the whole new file). */
  content: string
  /** improve only: id of the scanned file and the sha256 it had when proposed. */
  targetId?: string
  targetPath?: string
  baseSha256?: string
  baseContent?: string
  diff?: string
  diffStats?: DiffStats
  closest: Closest[]
  validation: { wouldLoad: boolean; issues: Issue[] }
  status: ProposalStatus
  decidedAt?: number
  /** Where an approved new skill was written (or the improved file). */
  writtenPath?: string
  finalSha256?: string
  failure?: string
  /** Reject only: stop the same suggestion (name or content hash) from coming back. */
  suppress?: boolean
  contentHash: string
}

export interface LedgerEntry { at: number; name: string; contentHash: string; outcome: 'rejected' | 'approved' | 'suppressed'; kind: ProposalKind }

export interface ProposalState {
  version: 1
  proposals: Proposal[]
  ledger: LedgerEntry[]
}

export const hashContent = (text: string): string => createHash('sha256').update(text.trim()).digest('hex').slice(0, 16)

export function normalizeProposals(input: unknown): ProposalState {
  const r = (typeof input === 'object' && input !== null ? input : {}) as { proposals?: unknown; ledger?: unknown }
  return {
    version: 1,
    proposals: Array.isArray(r.proposals) ? (r.proposals as Proposal[]).filter(p => typeof p?.id === 'string' && typeof p.name === 'string' && typeof p.content === 'string').slice(-500) : [],
    ledger: Array.isArray(r.ledger) ? (r.ledger as LedgerEntry[]).filter(l => typeof l?.name === 'string').slice(-1000) : [],
  }
}

export interface ExistingSkill { name: string; description: string; path?: string; id?: string; editable?: boolean }
export interface Limits { maxPending: number; maxPendingPerSession: number }

export class ProposalError extends Error {
  constructor(readonly code: 'invalid' | 'duplicate' | 'limit' | 'suppressed' | 'secret' | 'covered' | 'not-found' | 'bad-state' | 'bad-request', message: string, readonly issues?: Issue[]) { super(message) }
}

export const MAX_CONTENT_BYTES = 40 * 1024
export const MAX_RATIONALE = 600
/** Overlap at or above this with an existing skill (and no improve intent) is treated as already covered. */
export const COVERED_SCORE = 0.62

export interface EnqueueInput {
  origin: Origin
  action: ProposalKind
  name: string
  content: string
  rationale: string
  evidence?: Evidence[]
}

export interface EnqueueContext {
  state: ProposalState
  existing: readonly ExistingSkill[]
  limits: Limits
  now?: number
  /** improve: loader for the current text and sha of the target file. */
  readTarget?: (skill: ExistingSkill) => Promise<{ text: string; sha256: string } | undefined>
}

/** Validate and build a pending proposal. Throws ProposalError with a model-readable message; never writes anything. */
export async function buildProposal(input: EnqueueInput, ctx: EnqueueContext): Promise<Proposal> {
  const now = ctx.now ?? Date.now()
  const name = input.name.trim()
  if (!SKILL_NAME.test(name) || name.length > 64) throw new ProposalError('invalid', `Skill name "${name}" must be lowercase kebab-case (a-z, 0-9, single hyphens), up to 64 characters.`)
  const rationale = input.rationale.trim().slice(0, MAX_RATIONALE)
  if (rationale.length < 10) throw new ProposalError('invalid', 'rationale is required: say in a sentence or two why this skill is worth keeping.')
  if (Buffer.byteLength(input.content) > MAX_CONTENT_BYTES) throw new ProposalError('invalid', `SKILL.md is too large (${String(Math.round(Buffer.byteLength(input.content) / 1024))} KB, limit ${String(MAX_CONTENT_BYTES / 1024)} KB). Keep the skill focused and move detail into referenced files.`)
  if (containsSecret(input.content) || containsSecret(rationale)) throw new ProposalError('secret', 'The proposal contains something that looks like a secret (key, token, password). Remove it and propose again.')
  const content = input.content.endsWith('\n') ? input.content : `${input.content}\n`
  const v = validateSkillText(content, name)
  const errors = v.issues.filter(i => i.level === 'error')
  if (errors.length > 0) throw new ProposalError('invalid', `SKILL.md would not load in DSH: ${errors.map(e => e.message).join(' ')}`, v.issues)
  if (v.name !== name) throw new ProposalError('invalid', `The name in the frontmatter ("${v.name ?? ''}") must equal the name argument ("${name}").`)
  const contentHash = hashContent(content)

  const live = ctx.state.proposals
  if (live.some(p => p.status === 'pending' && (p.contentHash === contentHash || (p.name === name && p.kind === input.action)))) {
    throw new ProposalError('duplicate', `A proposal for "${name}" is already waiting for the user's review.`)
  }
  if (ctx.state.ledger.some(l => (l.outcome === 'suppressed' && (l.name === name || l.contentHash === contentHash)) || (l.outcome === 'rejected' && l.contentHash === contentHash))) {
    throw new ProposalError('suppressed', `The user already rejected this suggestion ("${name}"). Do not propose it again.`)
  }
  const pending = live.filter(p => p.status === 'pending')
  if (pending.length >= ctx.limits.maxPending) throw new ProposalError('limit', `There are already ${String(pending.length)} proposals waiting for review. Ask the user to review them first.`)
  if (input.origin.sessionId !== undefined && pending.filter(p => p.origin.sessionId === input.origin.sessionId).length >= ctx.limits.maxPendingPerSession) {
    throw new ProposalError('limit', `This session already has ${String(ctx.limits.maxPendingPerSession)} proposals waiting for review. Continue the task; the user will review them.`)
  }
  const sameDay = live.some(p => p.name === name && p.createdAt > now - 86_400_000 && p.status !== 'pending')
  if (sameDay && input.origin.kind === 'reviewer') throw new ProposalError('duplicate', `"${name}" was already proposed today.`)

  const byName = ctx.existing.find(e => e.name === name)
  const closest = closestSkills(name, v.description ?? '', ctx.existing)
  let proposal: Proposal
  if (input.action === 'new') {
    if (byName !== undefined) throw new ProposalError('duplicate', `A skill named "${name}" already exists. To change it, propose action "improve" with the complete updated SKILL.md.`)
    const top = closest[0]
    if (top !== undefined && top.score >= COVERED_SCORE) throw new ProposalError('covered', `This looks already covered by the existing skill "${top.name}" (similarity ${String(top.score)}). If it needs changes, propose action "improve" for "${top.name}" instead.`)
    proposal = base()
  } else {
    if (byName === undefined) throw new ProposalError('invalid', `There is no existing skill named "${name}" to improve. Use action "new".`)
    if (byName.editable === false || byName.path === undefined || byName.id === undefined || ctx.readTarget === undefined) throw new ProposalError('invalid', `"${name}" is not an editable skill (plugin-provided or read-only). Propose a new skill with a different name instead.`)
    const target = await ctx.readTarget(byName)
    if (target === undefined) throw new ProposalError('invalid', `Could not read the current "${name}" skill.`)
    const d = unifiedDiff(target.text, content)
    if (d.text === '') throw new ProposalError('invalid', 'The proposed SKILL.md is identical to the current one.')
    proposal = { ...base(), targetId: byName.id, targetPath: byName.path, baseSha256: target.sha256, baseContent: target.text, diff: d.text, diffStats: d.stats }
  }
  return proposal

  function base(): Proposal {
    return {
      id: randomUUID(), createdAt: now, origin: input.origin, kind: input.action, name, rationale, evidence: (input.evidence ?? []).slice(0, 6).map(e => ({ sessionId: e.sessionId, ...(e.turn === undefined ? {} : { turn: e.turn }), ...(e.quote === undefined ? {} : { quote: e.quote.slice(0, 300) }) })),
      content, closest, validation: { wouldLoad: v.wouldLoad, issues: v.issues }, status: 'pending', contentHash,
    }
  }
}

export interface Decision { action: 'approve' | 'reject'; text?: string; suppress?: boolean }

/** Pure state check for a decision. The route performs the write (approve) and then calls `finish`. */
export function pendingOrThrow(state: ProposalState, id: string): Proposal {
  const p = state.proposals.find(x => x.id === id)
  if (p === undefined) throw new ProposalError('not-found', 'That proposal no longer exists.')
  if (p.status !== 'pending') throw new ProposalError('bad-state', `That proposal was already ${p.status}.`)
  return p
}

export function size(text: string): boolean { return Buffer.byteLength(text) <= Math.max(MAX_CONTENT_BYTES, BODY_SOFT_BYTES) }
