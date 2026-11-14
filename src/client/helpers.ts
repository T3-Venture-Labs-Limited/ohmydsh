import type { SkillRow } from './api.ts'
import type { T } from './locale.ts'

export function sourceLabel(t: T, source: string): string {
  switch (source) {
    case 'user-agents': return t('sourceUserAgents')
    case 'user-dsh': return t('sourceUserDsh')
    case 'project-agents': return t('sourceProjectAgents')
    case 'project-dsh': return t('sourceProjectDsh')
    case 'custom': return t('sourceCustom')
    default: return t('sourcePlugin')
  }
}

export function relativeTime(ms: number, now = Date.now()): string {
  const diff = Math.max(0, now - ms)
  const m = Math.floor(diff / 60_000)
  if (m < 1) return 'just now'
  if (m < 60) return `${String(m)} min ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${String(h)} h ago`
  const d = Math.round(h / 24)
  if (d < 60) return `${String(d)} d ago`
  return `${String(Math.round(d / 30))} mo ago`
}

export const isDisabled = (row: SkillRow): boolean => row.disabled === 'disabled-global' || row.disabled === 'disabled-workspace'

export type Filter = 'all' | 'enabled' | 'disabled' | 'issues'

export function matches(row: SkillRow, query: string, filter: Filter, source: string): boolean {
  if (filter === 'enabled' && (isDisabled(row) || row.state !== 'active')) return false
  if (filter === 'disabled' && !isDisabled(row)) return false
  if (filter === 'issues' && row.state === 'active' && row.errors === 0 && row.warnings === 0) return false
  if (source !== 'all' && row.source !== source) return false
  if (query.length > 0) {
    const q = query.toLowerCase()
    return row.name.toLowerCase().includes(q) || row.description.toLowerCase().includes(q)
  }
  return true
}

/** The page's own check of whether a name is taken among scanned active skills (the host re-checks on create). */
export function nameTaken(rows: readonly SkillRow[], name: string): boolean {
  return rows.some(r => r.name === name && r.state !== 'invalid')
}

export const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
