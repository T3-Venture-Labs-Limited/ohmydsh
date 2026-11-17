// @vitest-environment node
import { mkdtempSync, mkdirSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { redact, containsSecret } from '../src/host/redact.ts'
import { unifiedDiff } from '../src/host/diff.ts'
import { closestSkills } from '../src/host/dedupe.ts'
import { buildProposal, normalizeProposals, pendingOrThrow, ProposalError, type ProposalState } from '../src/host/proposals.ts'
import { condenseSession, summarizeArguments } from '../src/host/transcript.ts'
import { aggregate, parseCandidates } from '../src/host/reviewer-core.ts'
import { normalizeReview, runReview, type ReviewerDeps } from '../src/host/reviewer.ts'
import { DEFAULT_CONFIG, normalizeConfig } from '../src/host/evolution-config.ts'
import { createProposeSkillTool } from '../src/host/tool.ts'

const base = join(import.meta.dirname, '..', '.tmp', 'tests')
mkdirSync(base, { recursive: true })

const skillText = (name: string, desc = 'Does something useful when asked about widgets.') => `---\nname: ${name}\ndescription: ${desc}\n---\n\n# ${name}\n1. Do the thing.\n2. Check the result.\n`
const fresh = (): ProposalState => normalizeProposals(undefined)
const ctx = (state = fresh(), existing: { name: string; description: string; path?: string; id?: string; editable?: boolean }[] = []) => ({ state, existing, limits: { maxPending: 5, maxPendingPerSession: 2 }, now: 1_000_000 })
const input = (over: Record<string, unknown> = {}) => ({ origin: { kind: 'tool' as const, sessionId: 's1' }, action: 'new' as const, name: 'widget-recipe', content: skillText('widget-recipe'), rationale: 'Repeated widget steps across the session.', ...over })

describe('redaction', () => {
  it('removes common secret shapes and leaves normal text', () => {
    const s = 'key sk-abcdefghijklmnopqrstuv, ghp_abcdefghijklmnopqrstuvwxyz0123 and AKIAABCDEFGHIJKLMNOP; Authorization: Bearer abcdefghijklmnop.qrst; OPENAI_API_KEY=abc123xyz; password: "hunter2hunter2"; https://user:pw12345@host/x'
    const r = redact(s)
    for (const leak of ['sk-abcdefghijklmnopqrstuv', 'ghp_abcdef', 'AKIAABCDEFGHIJKLMNOP', 'abcdefghijklmnop.qrst', 'abc123xyz', 'hunter2hunter2', 'pw12345']) expect(r).not.toContain(leak)
    expect(redact('Use pnpm install then run the tests')).toBe('Use pnpm install then run the tests')
    expect(containsSecret('-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----')).toBe(true)
  })
})

describe('diff + dedupe', () => {
  it('produces a unified diff with stats and an empty diff for equal text', () => {
    const d = unifiedDiff('a\nb\nc\nd\n', 'a\nb\nX\nd\n')
    expect(d.text).toContain('-c')
    expect(d.text).toContain('+X')
    expect(d.stats.added).toBe(1)
    expect(unifiedDiff('same\n', 'same\n').text).toBe('')
  })
  it('ranks overlapping skills by description similarity', () => {
    const c = closestSkills('pdf-fill', 'Fill and merge PDF forms', [{ name: 'pdf-tools', description: 'Merge, split and fill PDF forms' }, { name: 'sentry-cli', description: 'Use the Sentry CLI for issues' }])
    expect(c[0]?.name).toBe('pdf-tools')
  })
})

describe('proposal queue rules', () => {
  it('builds a pending proposal for a valid new skill and never touches the filesystem', async () => {
    const dir = mkdtempSync(join(base, 'q-'))
    const before = readdirSync(dir)
    const p = await buildProposal(input(), ctx())
    expect(p.status).toBe('pending')
    expect(p.kind).toBe('new')
    expect(p.validation.wouldLoad).toBe(true)
    expect(readdirSync(dir)).toEqual(before)
  })
  it('rejects invalid frontmatter, mismatched names, secrets, oversize and bad names with readable errors', async () => {
    await expect(buildProposal(input({ content: '# nope' }), ctx())).rejects.toMatchObject({ code: 'invalid' })
    await expect(buildProposal(input({ content: skillText('other-name') }), ctx())).rejects.toMatchObject({ code: 'invalid' })
    await expect(buildProposal(input({ content: `${skillText('widget-recipe')}\nexport TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123\n` }), ctx())).rejects.toMatchObject({ code: 'secret' })
    await expect(buildProposal(input({ content: skillText('widget-recipe') + 'x'.repeat(50_000) }), ctx())).rejects.toMatchObject({ code: 'invalid' })
    await expect(buildProposal(input({ name: 'Bad Name' }), ctx())).rejects.toMatchObject({ code: 'invalid' })
    await expect(buildProposal(input({ rationale: 'short' }), ctx())).rejects.toMatchObject({ code: 'invalid' })
  })
  it('refuses a new skill whose name exists or whose purpose an existing skill already covers', async () => {
    await expect(buildProposal(input(), ctx(fresh(), [{ name: 'widget-recipe', description: 'x' }]))).rejects.toMatchObject({ code: 'duplicate' })
    const covered = await buildProposal(input({ name: 'widget-helper', content: skillText('widget-helper', 'Does something useful when asked about widgets and gadgets.') }), ctx(fresh(), [{ name: 'widget-tools', description: 'Does something useful when asked about widgets and gadgets.' }])).catch((e: ProposalError) => e)
    expect((covered as ProposalError).code).toBe('covered')
  })
  it('enforces per-session and global pending caps, duplicates and the rejection ledger', async () => {
    const st = fresh()
    const add = async (name: string, session = 's1') => { st.proposals.push(await buildProposal(input({ name, content: skillText(name, `Unique purpose ${name} alpha`), origin: { kind: 'tool', sessionId: session } }), ctx(st))) }
    await add('aa-one'); await add('bb-two')
    await expect(add('cc-three')).rejects.toMatchObject({ code: 'limit' })
    await expect(buildProposal(input({ name: 'aa-one', content: skillText('aa-one', 'Unique purpose aa-one alpha') }), ctx(st))).rejects.toMatchObject({ code: 'duplicate' })
    st.ledger.push({ at: 1, name: 'zz-never', contentHash: 'x', outcome: 'suppressed', kind: 'new' })
    await expect(buildProposal(input({ name: 'zz-never', content: skillText('zz-never', 'Totally different words banana') , origin: { kind: 'tool', sessionId: 's9' } }), ctx(st))).rejects.toMatchObject({ code: 'suppressed' })
  })
  it('improve: needs an editable existing skill, captures a diff and the base hash', async () => {
    const existing = [{ name: 'widget-recipe', description: 'old', path: '/x/SKILL.md', id: '/x/SKILL.md', editable: true }]
    const readTarget = async () => ({ text: skillText('widget-recipe'), sha256: 'abc' })
    const p = await buildProposal(input({ action: 'improve', content: skillText('widget-recipe').replace('Check the result.', 'Check the result twice.') }), { ...ctx(fresh(), existing), readTarget })
    expect(p.kind).toBe('improve')
    expect(p.baseSha256).toBe('abc')
    expect(p.diff).toContain('+2. Check the result twice.')
    await expect(buildProposal(input({ action: 'improve', name: 'missing-skill', content: skillText('missing-skill') }), { ...ctx(fresh(), existing), readTarget })).rejects.toMatchObject({ code: 'invalid' })
    await expect(buildProposal(input({ action: 'improve' }), { ...ctx(fresh(), [{ ...existing[0]!, editable: false }]), readTarget })).rejects.toMatchObject({ code: 'invalid' })
    await expect(buildProposal(input({ action: 'improve' }), { ...ctx(fresh(), existing), readTarget })).rejects.toMatchObject({ code: 'invalid' }) // identical
  })
  it('only pending proposals can be decided', () => {
    const st = fresh()
    expect(() => pendingOrThrow(st, 'nope')).toThrow(ProposalError)
  })
})

describe('propose_skill tool', () => {
  it('queues and answers at once; reports refusals as readable text instead of throwing', async () => {
    const calls: string[] = []
    const tool = createProposeSkillTool({
      enabled: () => true,
      enqueue: async (i) => { calls.push(i.name); if (i.name === 'bad-one') throw new ProposalError('invalid', 'SKILL.md would not load'); return { id: 'p1', kind: i.action, name: i.name } },
    })
    const exec = { agent: { id: 'sess-1' }, callId: 'c1', signal: new AbortController().signal } as never
    const good = await (tool as unknown as { execute(a: unknown, e: unknown): Promise<{ queued: boolean; message: string }> }).execute({ action: 'new', name: 'good-one', content: 'x', rationale: 'y' }, exec)
    expect(good.queued).toBe(true)
    expect(good.message).toMatch(/Nothing is written until they approve/)
    const bad = await (tool as unknown as { execute(a: unknown, e: unknown): Promise<{ queued: boolean; message: string }> }).execute({ action: 'new', name: 'bad-one', content: 'x', rationale: 'y' }, exec)
    expect(bad).toMatchObject({ queued: false, message: 'SKILL.md would not load' })
    expect(calls).toEqual(['good-one', 'bad-one'])
  })
  it('answers "switched off" without queueing when disabled', async () => {
    const tool = createProposeSkillTool({ enabled: () => false, enqueue: async () => { throw new Error('must not run') } })
    const r = await (tool as unknown as { execute(a: unknown, e: unknown): Promise<{ queued: boolean }> }).execute({ action: 'new', name: 'a', content: 'x', rationale: 'y' }, { agent: { id: 's' }, callId: 'c', signal: new AbortController().signal })
    expect(r.queued).toBe(false)
  })
})

describe('transcript condenser', () => {
  const events = [
    { type: 'user/message', seq: 1, data: { content: [{ type: 'text', text: 'Please fix the build. key sk-abcdefghijklmnopqrstuv <system-reminder>hidden</system-reminder>' }], source: { kind: 'user' } } },
    { type: 'user/message', seq: 2, data: { content: [{ type: 'text', text: '<available_skills>- a: b</available_skills>' }], source: { kind: 'skill-catalog' } } },
    { type: 'assistant/message', seq: 3, data: { message: { content: [{ type: 'text', text: 'Running it.' }] } } },
    { type: 'tool/call', seq: 4, data: { name: 'bash', arguments: JSON.stringify({ command: 'pnpm build', description: 'x' }) } },
    { type: 'tool/result', seq: 5, data: { message: { content: [{ type: 'text', text: 'SECRET-OUTPUT-SHOULD-NEVER-APPEAR password=abc' }] } } },
    { type: 'tool/call', seq: 6, data: { name: 'skill', arguments: JSON.stringify({ name: 'dsh-doc' }) } },
  ]
  it('includes user text and tool CALLS but never tool results, catalogs or reminders; redacts secrets', () => {
    const c = condenseSession(events, 10_000)
    expect(c.text).toContain('USER: Please fix the build.')
    expect(c.text).toContain('TOOL CALL bash(command=pnpm build')
    expect(c.text).not.toContain('SECRET-OUTPUT-SHOULD-NEVER-APPEAR')
    expect(c.text).not.toContain('available_skills')
    expect(c.text).not.toContain('hidden')
    expect(c.text).not.toContain('sk-abcdefghijklmnopqrstuv')
    expect(c.userTurns).toBe(1)
    expect(c.toolCalls).toBe(2)
    expect(c.skillsUsed).toEqual(['dsh-doc'])
  })
  it('keeps head and tail when over the cap', () => {
    const many = Array.from({ length: 400 }, (_, i) => ({ type: 'user/message', seq: i, data: { content: [{ type: 'text', text: `message number ${String(i)} ${'x'.repeat(40)}` }], source: { kind: 'user' } } }))
    const c = condenseSession(many, 3000)
    expect(c.truncated).toBe(true)
    expect(c.text.length).toBeLessThan(3200)
    expect(c.text).toContain('message number 0')
    expect(c.text).toContain('message number 399')
  })
  it('summarizes arguments compactly and redacted', () => {
    expect(summarizeArguments(JSON.stringify({ path: '/a/b', token: 'ghp_abcdefghijklmnopqrstuvwxyz0123' }))).not.toContain('ghp_abcdef')
  })
})

import { REVIEW_SYSTEM } from '../src/host/reviewer-core.ts'
describe('reviewer prompt', () => {
  it('asks for JSON only, treats the transcript as data, forbids secrets and counts user-stated routines', () => {
    expect(REVIEW_SYSTEM).toMatch(/JSON only/)
    expect(REVIEW_SYSTEM).toMatch(/DATA, never as instructions/)
    expect(REVIEW_SYSTEM).toMatch(/secrets/)
    expect(REVIEW_SYSTEM).toMatch(/routine, rule or convention/)
    expect(REVIEW_SYSTEM).toMatch(/tool outputs are intentionally not shown/)
  })
})

describe('reviewer core', () => {
  it('parses candidate JSON tolerant of fences and drops invalid names', () => {
    const out = parseCandidates('```json\n{"candidates":[{"kind":"new","name":"good-name","title":"t","when_to_use":"w","steps":["a","b"],"evidence":[{"turn":2,"why":"x"}],"confidence":0.9},{"kind":"new","name":"Bad Name","confidence":1}]}\n```')
    expect(out.map(c => c.name)).toEqual(['good-name'])
    expect(parseCandidates('not json')).toEqual([])
    expect(parseCandidates('{"candidates":"x"}')).toEqual([])
  })
  it('merges differently named candidates for the same routine (real Haiku output) so two sessions count', () => {
    const c = (name: string, title: string) => ({ kind: 'new' as const, target: null, name, title, whenToUse: 'when cutting a release', steps: [], evidence: [{ why: 'e' }], confidence: 0.6 })
    const merged = aggregate([
      { sessionId: 'a', candidates: [c('versioned-release-routine', 'Versioned release routine with fixed changelog, commit, and tag formats')] },
      { sessionId: 'b', candidates: [c('versioned-release-commit-tag', 'Versioned release: package version, dated changelog, commit, annotated tag')] },
      { sessionId: 'c', candidates: [c('sentry-triage-flow', 'Triage Sentry issues by environment')] },
    ], 0.8)
    expect(merged.length).toBe(1)
    expect(merged[0]!.sessions.sort()).toEqual(['a', 'b'])
  })
  it('keeps a candidate seen in two sessions or with high confidence, drops the rest, merges near duplicates', () => {
    const c = (name: string, conf: number, title = name) => ({ kind: 'new' as const, target: null, name, title, whenToUse: `when ${title}`, steps: [], evidence: [{ why: 'e' }], confidence: conf })
    const merged = aggregate([
      { sessionId: 'a', candidates: [c('shared-recipe', 0.5), c('lonely-low', 0.4), c('lonely-high', 0.9)] },
      { sessionId: 'b', candidates: [c('shared-recipe', 0.6)] },
    ], 0.8)
    expect(merged.map(m => m.candidate.name).sort()).toEqual(['lonely-high', 'shared-recipe'])
    expect(merged.find(m => m.candidate.name === 'shared-recipe')?.sessions).toEqual(['a', 'b'])
  })
})

describe('reviewer run', () => {
  function deps(over: Partial<ReviewerDeps> = {}, seen: { prompts: string[]; proposals: string[] } = { prompts: [], proposals: [] }) {
    let state = normalizeReview(undefined)
    const events = (id: string) => [
      { type: 'user/message', seq: 1, data: { content: [{ type: 'text', text: `do ${id} work` }], source: { kind: 'user' } } },
      { type: 'user/message', seq: 2, data: { content: [{ type: 'text', text: 'again' }], source: { kind: 'user' } } },
      { type: 'user/message', seq: 3, data: { content: [{ type: 'text', text: 'and again' }], source: { kind: 'user' } } },
      ...Array.from({ length: 5 }, (_, i) => ({ type: 'tool/call', seq: 10 + i, data: { name: 'bash', arguments: '{"command":"echo"}' } })),
      { type: 'tool/result', seq: 20, data: { message: { content: [{ type: 'text', text: 'TOOL-OUTPUT-LEAK' }] } } },
    ]
    const d: ReviewerDeps = {
      config: () => ({ ...DEFAULT_CONFIG.reviewer, enabled: true, minUserTurns: 1, minToolCalls: 1 }),
      route: () => ({ provider: 'claude', model: 'claude-haiku-5-5', effort: 'low' }),
      listSessions: async () => [{ id: 's-a', createdAt: 2 }, { id: 's-b', createdAt: 1 }, { id: 's-sub', createdAt: 3, origin: 'subagent' }],
      readEvents: async (id) => ({ events: events(id) }),
      isLive: () => false,
      existing: async () => [{ name: 'dsh-doc', description: 'DSH docs' }],
      currentText: async () => undefined,
      enqueue: async (i) => { seen.proposals.push(`${i.origin.kind}:${i.name}`) },
      llm: async (system, user) => {
        seen.prompts.push(user)
        if (system.startsWith('You review')) return { text: '{"candidates":[{"kind":"new","name":"repeat-recipe","title":"Repeat recipe","when_to_use":"when repeating","steps":["a"],"evidence":[{"turn":1,"why":"w"}],"confidence":0.5}]}', tokens: 500 }
        return { text: skillText('repeat-recipe', 'Repeats a recipe when asked to repeat things.'), tokens: 400 }
      },
      state: () => state,
      save: async (mutate) => { const copy = structuredClone(state); mutate(copy); state = copy },
      now: () => Date.UTC(2026, 10, 14, 12),
      ...over,
    }
    return { d, seen, get state() { return state } }
  }
  it('reviews sessions, never sends tool outputs, skips subagents, needs two sessions for a low-confidence pattern, and logs the run', async () => {
    const h = deps()
    const run = await runReview(h.d, 'manual')
    expect(run.sessionsReviewed).toBe(2)
    expect(run.reviewed.sort()).toEqual(['s-a', 's-b'])
    expect(run.skipped.subagent).toBe(1)
    expect(run.proposals).toBe(1)
    expect(h.seen.proposals).toEqual(['reviewer:repeat-recipe'])
    expect(h.seen.prompts.join('\n')).not.toContain('TOOL-OUTPUT-LEAK')
    expect(h.state.runs.length).toBe(1)
    expect(h.state.cursor['s-a']).toBeGreaterThan(0)
    expect(h.state.tokens['2026-11-14']).toBe(run.tokens)
  })
  it('does not re-review unchanged sessions and honours the daily token budget', async () => {
    const h = deps()
    await runReview(h.d, 'sweep')
    const again = await runReview(h.d, 'sweep')
    expect(again.sessionsReviewed).toBe(0)
    expect(again.skipped['already-reviewed']).toBe(2)
    const tight = deps({ config: () => ({ ...DEFAULT_CONFIG.reviewer, enabled: true, minUserTurns: 1, minToolCalls: 1, maxTokensPerDay: 1000 }) })
    const run = await runReview(tight.d, 'manual')
    expect(run.status).toBe('budget')
    expect(tight.seen.proposals.length).toBe(0)
  })
  it('keeps going when one LLM call fails and records the error; excluded workspaces are skipped', async () => {
    let n = 0
    const h = deps({ llm: async (system) => { n += 1; if (n === 1) throw new Error('provider down'); return { text: system.startsWith('You review') ? '{"candidates":[]}' : '', tokens: 10 } }, listSessions: async () => [{ id: 's-a', createdAt: 2 }, { id: 's-b', createdAt: 1 }, { id: 's-x', createdAt: 0, cwd: '/secret/project' }], config: () => ({ ...DEFAULT_CONFIG.reviewer, enabled: true, minUserTurns: 1, minToolCalls: 1, excludeCwds: ['/secret'] }) })
    const run = await runReview(h.d, 'manual')
    expect(run.errors.length).toBe(1)
    expect(run.status).toBe('partial')
    expect(run.skipped['excluded-workspace']).toBe(1)
  })
})

describe('config', () => {
  it('defaults the reviewer OFF with a cheap model and clamps bad values', () => {
    const c = normalizeConfig({ reviewer: { enabled: 'yes', maxSessionsPerRun: 9999, model: '', idleMinutes: -5 }, approveTarget: 'nowhere' })
    expect(DEFAULT_CONFIG.reviewer.enabled).toBe(false)
    expect(DEFAULT_CONFIG.reviewer.model).toBe('claude-sonnet-5-5')
    expect(c.reviewer.enabled).toBe(false)
    expect(c.reviewer.maxSessionsPerRun).toBe(50)
    expect(c.reviewer.model).toBe('claude-sonnet-5-5')
    expect(c.approveTarget).toBe('user-agents')
  })
})
