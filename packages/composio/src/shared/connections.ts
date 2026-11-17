// Pure view-model helpers for the Connections tab: account labels, status classification, search / filter / sort.
import { prettifySlug } from './names.ts'

export interface AccountLike { id?: string; wordId: string; alias: string | null; displayName?: string | null; status: string }
export interface ToolkitLike { slug: string; name: string; logo?: string | null; accounts: AccountLike[]; hasExpired: boolean }
export type StatusFilter = 'all' | 'active' | 'attention'
export type Tone = 'ok' | 'warn' | 'error' | 'idle'

const clean = (v: string | null | undefined): string => (typeof v === 'string' ? v.trim() : '')

/** Human name of a toolkit: the catalog name, else a prettified slug (never the raw slug). */
export function toolkitName(t: Pick<ToolkitLike, 'slug' | 'name'>): string {
  const name = clean(t.name)
  return name === '' || name === t.slug ? prettifySlug(t.slug) : name
}

/**
 * What to call one account. The alias the user chose wins, then the provider's own name for the account (email,
 * username, workspace), then "Account N" (1-based position within the toolkit). `detail` is the extra human text
 * shown muted next to it; `id` is Composio's random word id, kept only as a small tooltip / monospace line.
 */
export function accountLabel(account: AccountLike, index: number): { primary: string; detail: string | null; id: string } {
  const alias = clean(account.alias); const display = clean(account.displayName)
  const primary = alias !== '' ? alias : display !== '' ? display : `Account ${String(index + 1)}`
  const detail = alias !== '' && display !== '' && display !== alias ? display : null
  return { primary, detail, id: account.wordId !== '' ? account.wordId : (account.id ?? '') }
}

/** An account needs attention unless it is working (ACTIVE) or still being set up (INITIALIZING). */
export const accountNeedsAttention = (status: string): boolean => status !== 'ACTIVE' && status !== 'INITIALIZING'
export const toolkitNeedsAttention = (t: Pick<ToolkitLike, 'accounts'>): boolean => t.accounts.some((a) => accountNeedsAttention(a.status))

export function statusTone(status: string): Tone {
  return status === 'ACTIVE' ? 'ok' : status === 'EXPIRED' ? 'error' : status === 'INITIALIZING' ? 'idle' : 'warn'
}

/** Case-insensitive match on app name, slug and the accounts' labels. */
export function matchesQuery(t: ToolkitLike, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (q === '') return true
  const hay = [toolkitName(t), t.slug, ...t.accounts.flatMap((a, i) => { const l = accountLabel(a, i); return [l.primary, l.detail ?? '', l.id] })]
  return hay.some((h) => h.toLowerCase().includes(q))
}

/** Needs-attention apps first, then alphabetical by display name (stable, locale aware). */
export function compareToolkits(a: ToolkitLike, b: ToolkitLike): number {
  const attention = Number(toolkitNeedsAttention(b)) - Number(toolkitNeedsAttention(a))
  return attention !== 0 ? attention : toolkitName(a).localeCompare(toolkitName(b), 'en', { sensitivity: 'base' }) || a.slug.localeCompare(b.slug)
}

export function visibleToolkits<T extends ToolkitLike>(rows: readonly T[], query: string, filter: StatusFilter): T[] {
  return rows
    .filter((t) => (filter === 'all' || (filter === 'attention' ? toolkitNeedsAttention(t) : !toolkitNeedsAttention(t))) && matchesQuery(t, query))
    .sort(compareToolkits)
}

export function countToolkits(rows: readonly ToolkitLike[]): { apps: number; attention: number; accounts: number } {
  return { apps: rows.length, attention: rows.filter(toolkitNeedsAttention).length, accounts: rows.reduce((n, t) => n + t.accounts.length, 0) }
}

/** Letter for the fallback avatar. */
export const avatarLetter = (name: string): string => (/[\p{L}\p{N}]/u.exec(name)?.[0] ?? '?').toUpperCase()
