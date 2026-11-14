// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { capture, redactString, sanitize } from '../src/host/redact.ts'
import { costDetails, presentMessages, usageDetails } from '../src/host/present.ts'

describe('redaction', () => {
  it('scrubs bearer tokens, vendor keys, URL credentials and *_API_KEY assignments', () => {
    const out = redactString('Authorization: Bearer abc.def-123 sk-ant-abcdefghijk https://u:p4ss@host/x OPENAI_API_KEY=hunter2hunter2 pk-lf-1234-abcd')
    expect(out).not.toMatch(/abc\.def|sk-ant-abcdefghijk|p4ss|hunter2|pk-lf-1234/)
  })
  it('replaces known literal secrets and secret-named fields, omits binary', () => {
    const out = sanitize({ token: 'x', nested: { text: 'my-super-secret-value here', image: { type: 'image', data: 'AAAA', mimeType: 'image/png' } } }, ['my-super-secret-value']) as any
    expect(out.token).toBe('[redacted-secret]')
    expect(out.nested.text).toBe('[redacted-secret] here')
    expect(out.nested.image).toEqual({ type: 'image', mimeType: 'image/png', omitted: true })
  })
  it('survives cycles and does not mutate its input', () => {
    const a: any = { name: 'a' }; a.self = a
    expect((sanitize(a) as any).self).toBe('[circular-ref]')
    const input = { password: 'p' }
    sanitize(input)
    expect(input.password).toBe('p')
  })
  it('caps oversized content with a head+tail excerpt', () => {
    const c = capture('x'.repeat(5000), [], 1000)
    expect(c.truncated).toBe(true)
    expect(c.originalChars).toBe(5000)
    expect((c.value as any).head.length).toBe(500)
  })
})

describe('usage mapping', () => {
  it('splits reasoning out of output and keeps cache buckets', () => {
    expect(usageDetails({ inputTokens: 10, outputTokens: 30, reasoningTokens: 12, cacheReadTokens: 100, cacheWriteTokens: 5 })).toEqual({
      input: 10, output: 18, output_reasoning_tokens: 12, cache_read_input_tokens: 100, cache_creation_input_tokens: 5,
    })
  })
  it('does not split when reasoning exceeds output', () => {
    expect(usageDetails({ inputTokens: 1, outputTokens: 5, reasoningTokens: 9 })).toEqual({ input: 1, output: 5 })
  })
  it('prices every bucket with a matching key and total', () => {
    const cost = costDetails({ inputTokens: 1_000_000, outputTokens: 2_000_000, cacheReadTokens: 1_000_000 }, { input: 1, output: 2, cacheRead: 0.1 })
    expect(cost).toEqual({ input: 1, output: 4, cache_read_input_tokens: 0.1, total: 5.1 })
    expect(costDetails({ inputTokens: 5 }, undefined)).toBeUndefined()
  })
  it('hides the system prompt body when configured', () => {
    const [m] = presentMessages([{ role: 'system', content: [{ type: 'text', text: 'secret prompt' }] }], { includeReasoning: true, includeSystemPrompt: false }) as any[]
    expect(m.content).toMatch(/omitted: 13 chars/)
  })
})

// LF-1 regression: patterns the reviewer found missing.
describe('redaction gaps (LF-1)', () => {
  // Built at runtime so no scanner mistakes a fixture for a real credential.
  const fixtures: [string, string][] = [
    ['Composio user key', 'uak_' + 'AbCdEf0123456789xyz'],
    ['AWS access key', 'AKIA' + 'ABCDEFGHIJKLMNOP'],
    ['AWS temp key', 'ASIA' + 'ABCDEFGHIJKLMNOP'],
    ['Slack bot token', 'xoxb-' + '1234567890-abcdefghij'],
    ['Slack user token', 'xoxp-' + '1234567890-abcdefghij'],
    ['Slack app token', 'xapp-1-' + 'A0123456789-abcdef'],
    ['GitLab token', 'glpat-' + 'abcdefghij0123456789'],
    ['Google API key', 'AIza' + 'SyA-1234567890abcdefghijklmnopqrstu'],
    ['JWT', 'eyJhbGciOiJIUzI1NiJ9.' + 'eyJzdWIiOiIxMjM0NTY3ODkwIn0.' + 'abcdefghijklmnop0123'],
    ['GitHub fine-grained', 'github_pat_' + '11ABCDEFG0123456789_abcdefghij'],
  ]
  it.each(fixtures)('redacts %s', (_label, secret) => {
    const out = redactString(`before ${secret} after`)
    expect(out).not.toContain(secret)
    expect(out).toContain('before')
    expect(out).toContain('after')
  })
  it('redacts a PEM block, also when truncated by the size cap', () => {
    const body = 'MIIEvQIBADANBgkqhkiG9w0BAQEFAASC'
    const full = redactString(`x\n-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----\ny`)
    expect(full).not.toContain(body)
    expect(full).toMatch(/^x\n/)
    expect(full).toMatch(/\ny$/)
    expect(redactString(`-----BEGIN RSA PRIVATE KEY-----\n${body}`)).not.toContain(body)
  })
  it('redacts plain `token: value`, `password = value`, JSON and YAML shapes (any name containing token/secret/password)', () => {
    for (const text of ['token: abcdefgh12345678', 'password = hunter2hunter2', '{"secret":"abcdef123456"}', 'client_secret: s3cr3tvalue99', 'authorization: abcdefgh12345', 'MY_SERVICE_TOKEN=abcdef123456', 'GITHUB_TOKEN: abcdef123456']) {
      const out = redactString(text)
      expect(out, text).toMatch(/\[redacted-secret\]/)
      expect(out, text).not.toMatch(/abcdefgh12345678|hunter2hunter2|abcdef123456|s3cr3tvalue99|abcdefgh12345/)
    }
  })
  it('does not eat ordinary prose or short values', () => {
    expect(redactString('The token count is high and password policies matter.')).toBe('The token count is high and password policies matter.')
    expect(redactString('token: abc')).toBe('token: abc')
  })
  it('capture() applies the new rules to nested tool results before they leave the process', () => {
    const c = capture({ result: { text: 'sent via uak_' + 'AbCdEf0123456789xyz and AKIA' + 'ABCDEFGHIJKLMNOP' } }, [], 10_000)
    expect(JSON.stringify(c.value)).not.toMatch(/uak_AbCd|AKIAABCD/)
  })
})
