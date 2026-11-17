// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { accountLabel, avatarLetter, countToolkits, matchesQuery, statusTone, toolkitName, visibleToolkits } from '../src/shared/connections.ts'
import type { ToolkitLike } from '../src/shared/connections.ts'
import { prettifySlug, safeLogoUrl } from '../src/shared/names.ts'

const tk = (slug: string, statuses: string[], name = '', extra: { alias?: string | null; displayName?: string | null }[] = []): ToolkitLike => ({
  slug, name, hasExpired: statuses.some((s) => s !== 'ACTIVE'),
  accounts: statuses.map((status, i) => ({ wordId: `${slug}_w${String(i)}`, status, alias: extra[i]?.alias ?? null, displayName: extra[i]?.displayName ?? null })),
})

describe('display names and logos', () => {
  it('prettifies raw slugs', () => {
    expect(prettifySlug('agent_mail')).toBe('Agent Mail')
    expect(prettifySlug('google_maps')).toBe('Google Maps')
    expect(prettifySlug('_1password')).toBe('1password')
    expect(prettifySlug('')).toBe('')
  })
  it('prefers the catalog name, never shows the raw slug', () => {
    expect(toolkitName({ slug: 'apify', name: 'Apify' })).toBe('Apify')
    expect(toolkitName({ slug: 'agent_mail', name: 'agent_mail' })).toBe('Agent Mail')
    expect(toolkitName({ slug: 'agent_mail', name: '  ' })).toBe('Agent Mail')
  })
  it('accepts only plain https logo URLs', () => {
    expect(safeLogoUrl('https://logos.composio.dev/api/gmail')).toBe('https://logos.composio.dev/api/gmail')
    for (const bad of ['http://x.test/a.png', 'javascript:alert(1)', 'data:image/png;base64,AA', 'https://u:p@x.test/a.png', 42, null, '']) expect(safeLogoUrl(bad)).toBeNull()
  })
  it('letter avatar fallback', () => {
    expect(avatarLetter('Apify')).toBe('A')
    expect(avatarLetter('1password')).toBe('1')
    expect(avatarLetter('')).toBe('?')
  })
})

describe('account label', () => {
  it('alias wins, the provider name rides along, the random id stays as detail', () => {
    expect(accountLabel({ wordId: 'stripe_canada-fany', alias: 'myah', displayName: 'Myah', status: 'ACTIVE' }, 0)).toEqual({ primary: 'myah', detail: 'Myah', id: 'stripe_canada-fany' })
    expect(accountLabel({ wordId: 'w', alias: 'deestax', displayName: 'deestax', status: 'ACTIVE' }, 0).detail).toBeNull()
  })
  it('falls back to the provider name, then "Account N"', () => {
    expect(accountLabel({ wordId: 'w1', alias: null, displayName: 'someone@example.com', status: 'ACTIVE' }, 0).primary).toBe('someone@example.com')
    expect(accountLabel({ wordId: 'apify_kersey-gol', alias: null, status: 'ACTIVE' }, 0).primary).toBe('Account 1')
    expect(accountLabel({ wordId: 'apify_herne-pinch', alias: '  ', displayName: '', status: 'EXPIRED' }, 1)).toEqual({ primary: 'Account 2', detail: null, id: 'apify_herne-pinch' })
  })
  it('uses the connection id when there is no word id', () => {
    expect(accountLabel({ id: 'ca_123', wordId: '', alias: null, status: 'ACTIVE' }, 0).id).toBe('ca_123')
  })
})

describe('status', () => {
  it('tones', () => {
    expect(statusTone('ACTIVE')).toBe('ok')
    expect(statusTone('EXPIRED')).toBe('error')
    expect(statusTone('INITIALIZING')).toBe('idle')
    expect(statusTone('FAILED')).toBe('warn')
  })
})

describe('search, filter, sort', () => {
  const rows = [
    tk('zoom', ['ACTIVE'], 'Zoom'),
    tk('apify', ['ACTIVE', 'EXPIRED'], 'Apify'),
    tk('github', ['ACTIVE'], 'GitHub', [{ alias: 'deestax', displayName: 'deestax' }]),
    tk('agent_mail', ['ACTIVE'], 'agent_mail'),
    tk('cal', ['EXPIRED'], 'Cal'),
    tk('slack', ['INITIALIZING'], 'Slack'),
  ]
  it('needs-attention first, then alphabetical by display name', () => {
    expect(visibleToolkits(rows, '', 'all').map((r) => r.slug)).toEqual(['apify', 'cal', 'agent_mail', 'github', 'slack', 'zoom'])
  })
  it('does not mutate the input order', () => {
    const copy = rows.map((r) => r.slug)
    visibleToolkits(rows, '', 'all')
    expect(rows.map((r) => r.slug)).toEqual(copy)
  })
  it('status filter: pending counts as healthy', () => {
    expect(visibleToolkits(rows, '', 'attention').map((r) => r.slug)).toEqual(['apify', 'cal'])
    expect(visibleToolkits(rows, '', 'active').map((r) => r.slug)).toEqual(['agent_mail', 'github', 'slack', 'zoom'])
  })
  it('search matches name, slug, alias and id, case-insensitively, and combines with the filter', () => {
    expect(visibleToolkits(rows, 'GIT', 'all').map((r) => r.slug)).toEqual(['github'])
    expect(visibleToolkits(rows, 'agent mail', 'all').map((r) => r.slug)).toEqual(['agent_mail'])
    expect(visibleToolkits(rows, 'agent_mail', 'all').map((r) => r.slug)).toEqual(['agent_mail'])
    expect(visibleToolkits(rows, 'deestax', 'all').map((r) => r.slug)).toEqual(['github'])
    expect(visibleToolkits(rows, 'apify_w1', 'all').map((r) => r.slug)).toEqual(['apify'])
    expect(visibleToolkits(rows, 'a', 'attention').map((r) => r.slug)).toEqual(['apify', 'cal'])
    expect(visibleToolkits(rows, 'zzz', 'all')).toEqual([])
    expect(matchesQuery(rows[0] as ToolkitLike, '   ')).toBe(true)
  })
  it('counts', () => {
    expect(countToolkits(rows)).toEqual({ apps: 6, attention: 2, accounts: 7 })
    expect(countToolkits([])).toEqual({ apps: 0, attention: 0, accounts: 0 })
  })
})
