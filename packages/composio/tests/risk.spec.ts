// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { gate, riskOf, slugInToolkit } from '../src/host/risk.ts'

describe('risk + approval gate', () => {
  it('classifies from tags', () => {
    expect(riskOf(['readOnlyHint', 'openWorldHint'])).toBe('read')
    expect(riskOf(['createHint'])).toBe('write')
    expect(riskOf(['destructiveHint', 'readOnlyHint'])).toBe('destructive')
    expect(riskOf(['important'])).toBe('unknown')
  })
  it('interactive: reads run, everything else asks', () => {
    expect(gate({ slug: 'GITHUB_LIST_ASSIGNEES', risk: 'read' })).toEqual({ kind: 'allow' })
    expect(gate({ slug: 'GITHUB_CREATE_AN_ISSUE', risk: 'write' }).kind).toBe('ask')
    expect(gate({ slug: 'X_Y', risk: 'unknown' }).kind).toBe('ask')
  })
  it('trigger run: allowlisted tools run, reads of allowlisted toolkits run, EVERYTHING ELSE PAUSES for approval', () => {
    const policy = { allowTools: ['GITHUB_CREATE_AN_ISSUE_COMMENT'], allowToolkits: ['github'] }
    expect(gate({ slug: 'GITHUB_CREATE_AN_ISSUE_COMMENT', risk: 'write', policy })).toEqual({ kind: 'allow' })
    expect(gate({ slug: 'GITHUB_LIST_ASSIGNEES', risk: 'read', policy })).toEqual({ kind: 'allow' })
    expect(gate({ slug: 'GITHUB_CREATE_AN_ISSUE', risk: 'write', policy }).kind).toBe('ask')
    expect(gate({ slug: 'GMAIL_FETCH_EMAILS', risk: 'read', policy }).kind).toBe('ask')
    expect(gate({ slug: 'GITHUB_DELETE_A_REPOSITORY', risk: 'destructive', policy: { ...policy, allowTools: ['GITHUB_DELETE_A_REPOSITORY'] } }).kind).toBe('ask')
  })
  it('matches toolkit prefixes exactly', () => {
    expect(slugInToolkit('GITHUB_X', 'github')).toBe(true)
    expect(slugInToolkit('GITHUBX_X', 'github')).toBe(false)
  })
})
