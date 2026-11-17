// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { validateSkillText, renderSkillTemplate } from '../src/host/frontmatter.ts'

const good = '---\nname: my-skill\ndescription: Does a thing when asked.\n---\n\n# Body\nSteps.\n'
const codes = (t: string, dir?: string) => validateSkillText(t, dir).issues.map(i => i.code)

describe('validateSkillText', () => {
  it('accepts a valid skill', () => {
    const v = validateSkillText(good, 'my-skill')
    expect(v.wouldLoad).toBe(true)
    expect(v.issues).toEqual([])
    expect(v.modelInvocable && v.userInvocable).toBe(true)
  })
  it('flags missing, unclosed and malformed frontmatter as errors that stop loading', () => {
    expect(codes('# no frontmatter')).toContain('no-frontmatter')
    expect(codes('---\nname: a\n')).toContain('unclosed-frontmatter')
    expect(codes('---\nname: [oops\n---\nbody')).toContain('yaml')
    expect(codes('---\n- a\n- b\n---\nbody')).toContain('yaml-shape')
    expect(validateSkillText('# no frontmatter').wouldLoad).toBe(false)
  })
  it('requires name and description and a kebab name', () => {
    expect(codes('---\ndescription: x\n---\nb')).toContain('name-missing')
    expect(codes('---\nname: x\n---\nb')).toContain('description-missing')
    const bad = validateSkillText('---\nname: Bad_Name\ndescription: x\n---\nb')
    expect(bad.wouldLoad).toBe(false)
    expect(bad.issues.map(i => i.code)).toContain('name-invalid')
  })
  it('warns (not errors) when the name differs from its folder', () => {
    const v = validateSkillText(good, 'other-dir')
    expect(v.wouldLoad).toBe(true)
    expect(v.issues.find(i => i.code === 'name-folder')?.level).toBe('warn')
  })
  it('rejects the legacy camelCase keys DSH silently drops', () => {
    const v = validateSkillText('---\nname: a\ndescription: d\ndisableModelInvocation: true\n---\nb')
    expect(v.wouldLoad).toBe(false)
    expect(v.issues.some(i => i.code === 'legacy-key' && /disable-model-invocation/.test(i.message))).toBe(true)
  })
  it('reads invocation flags incl. yes/no/on/off and rejects non-booleans', () => {
    const v = validateSkillText('---\nname: a\ndescription: d\ndisable-model-invocation: yes\nuser-invocable: off\n---\nb')
    expect(v.modelInvocable).toBe(false)
    expect(v.userInvocable).toBe(false)
    expect(validateSkillText('---\nname: a\ndescription: d\nuser-invocable: maybe\n---\nb').wouldLoad).toBe(false)
  })
  it('warns about long descriptions and empty or long bodies', () => {
    expect(codes(`---\nname: a\ndescription: ${'x'.repeat(600)}\n---\nb`)).toContain('description-catalog')
    expect(codes(`---\nname: a\ndescription: ${'x'.repeat(1100)}\n---\nb`)).toContain('description-long')
    expect(codes('---\nname: a\ndescription: d\n---\n')).toContain('body-empty')
    expect(codes(`---\nname: a\ndescription: d\n---\n${'line\n'.repeat(600)}`)).toContain('body-long')
  })
  it('handles CRLF files', () => {
    expect(validateSkillText('---\r\nname: a\r\ndescription: d\r\n---\r\nbody\r\n').wouldLoad).toBe(true)
  })
  it('template output validates and quotes tricky descriptions', () => {
    const text = renderSkillTemplate({ name: 'new-one', description: 'Use when: colons, "quotes" and #hash' })
    const v = validateSkillText(text, 'new-one')
    expect(v.wouldLoad).toBe(true)
    expect(v.description).toBe('Use when: colons, "quotes" and #hash')
  })
})
