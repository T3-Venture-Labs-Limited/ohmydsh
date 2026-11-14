/** Risk classification from Composio tool tags, and the approval gate for `composio_execute`. Pure. */
export type Risk = 'read' | 'write' | 'destructive' | 'unknown'

export function riskOf(tags: readonly string[]): Risk {
  if (tags.includes('destructiveHint')) return 'destructive'
  if (tags.includes('readOnlyHint')) return 'read'
  if (tags.includes('createHint') || tags.includes('updateHint')) return 'write'
  return 'unknown' // no hint at all: treated like a write
}

/** `GITHUB_CREATE_AN_ISSUE` -> toolkit prefix check against an allowlist entry (`github`). Handles slugs like `AGENT_MAIL_*`. */
export const slugInToolkit = (slug: string, toolkit: string): boolean => slug.toLowerCase().startsWith(`${toolkit.toLowerCase()}_`)

export interface RunPolicy { allowTools: readonly string[]; allowToolkits: readonly string[] }
export interface GateInput { slug: string; risk: Risk; policy?: RunPolicy | undefined }
export type Gate = { kind: 'allow' } | { kind: 'ask'; reason: string }

/**
 * - Interactive session (no policy): read-only tools run, everything else asks.
 * - Trigger run (policy): a slug on `allowTools` runs unless it is destructive; a read-only tool of an allowlisted toolkit
 *   runs; EVERYTHING ELSE PAUSES FOR HUMAN APPROVAL (design decision: pause + notify instead of auto-reject).
 */
export function gate(input: GateInput): Gate {
  const { slug, risk, policy } = input
  if (policy === undefined) return risk === 'read' ? { kind: 'allow' } : { kind: 'ask', reason: `${slug} is a ${risk === 'unknown' ? 'tool without a read-only tag' : risk} action` }
  if (policy.allowTools.includes(slug)) return risk === 'destructive' ? { kind: 'ask', reason: `${slug} is destructive; confirm even though the recipe allows it` } : { kind: 'allow' }
  if (risk === 'read' && policy.allowToolkits.some((t) => slugInToolkit(slug, t))) return { kind: 'allow' }
  return { kind: 'ask', reason: `Trigger run wants ${slug}, which is outside the recipe's allowlist` }
}
