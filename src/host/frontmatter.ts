// Mirrors the parse rules of @deepseek-ai/dsh-skill-filesystem (parseFrontmatter/parseSkillFile/parseInvocationPolicy)
// so the manager can say exactly why DSH silently drops a skill, and is stricter on the Agent Skills spec
// (Claude Code and pi read the same files).
import { parseDocument } from 'yaml'

export const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
export const NAME_MAX = 64
export const DESCRIPTION_MAX = 1024
export const CATALOG_DESCRIPTION_MAX = 500
export const BODY_SOFT_LINES = 500
export const BODY_SOFT_BYTES = 20 * 1024

export interface Issue {
  level: 'error' | 'warn'
  code: string
  message: string
  /** 1-based line in the file when known. */
  line?: number
}

export interface ParsedFrontmatter {
  data: Record<string, unknown>
  body: string
  /** 1-based line of the closing `---`. */
  endLine: number
}

export type FrontmatterResult = { ok: true; value: ParsedFrontmatter } | { ok: false; issue: Issue }

/** Split `---` delimited YAML frontmatter from the body. */
export function parseFrontmatter(raw: string): FrontmatterResult {
  const firstLineEnd = raw.indexOf('\n')
  if (firstLineEnd < 0 || raw.slice(0, firstLineEnd).replace(/\r$/, '') !== '---') {
    return { ok: false, issue: { level: 'error', code: 'no-frontmatter', message: 'The file must start with a line containing only `---` (YAML frontmatter).', line: 1 } }
  }
  const start = firstLineEnd + 1
  let lineStart = start
  let closingStart = -1
  let bodyStart = raw.length
  let lineNo = 1
  while (lineStart <= raw.length) {
    lineNo += 1
    const nl = raw.indexOf('\n', lineStart)
    const lineEnd = nl < 0 ? raw.length : nl
    if (raw.slice(lineStart, lineEnd).replace(/\r$/, '') === '---') {
      closingStart = lineStart
      bodyStart = nl < 0 ? raw.length : nl + 1
      break
    }
    if (nl < 0) break
    lineStart = nl + 1
  }
  if (closingStart < 0) {
    return { ok: false, issue: { level: 'error', code: 'unclosed-frontmatter', message: 'Frontmatter is never closed: add a closing `---` line.' } }
  }
  const yamlText = raw.slice(start, closingStart)
  const doc = parseDocument(yamlText)
  if (doc.errors.length > 0) {
    const first = doc.errors[0]!
    const line = first.linePos?.[0]?.line
    return { ok: false, issue: { level: 'error', code: 'yaml', message: `Invalid YAML in the frontmatter: ${first.message.split('\n')[0]}`, ...(line === undefined ? {} : { line: line + 1 }) } }
  }
  const data = doc.toJS() as unknown
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return { ok: false, issue: { level: 'error', code: 'yaml-shape', message: 'The frontmatter must be a YAML mapping (key: value pairs).', line: 2 } }
  }
  return { ok: true, value: { data: data as Record<string, unknown>, body: raw.slice(bodyStart), endLine: lineNo } }
}

function boolish(data: Record<string, unknown>, key: string): boolean | undefined | 'invalid' {
  if (!Object.hasOwn(data, key)) return undefined
  const v = data[key]
  if (typeof v === 'boolean') return v
  if (v === 1 || v === '1') return true
  if (v === 0 || v === '0') return false
  if (typeof v === 'string') {
    const l = v.toLowerCase()
    if (l === 'true' || l === 'yes' || l === 'on') return true
    if (l === 'false' || l === 'no' || l === 'off') return false
  }
  return 'invalid'
}

export interface Validation {
  /** Would the DSH filesystem provider load this file? */
  wouldLoad: boolean
  name?: string
  description?: string
  whenToUse?: string
  modelInvocable: boolean
  userInvocable: boolean
  issues: Issue[]
}

const LEGACY_KEYS: [string, string][] = [
  ['disableModelInvocation', 'disable-model-invocation'],
  ['modelInvocable', 'disable-model-invocation'],
  ['userInvocable', 'user-invocable'],
]

/** Validate one SKILL.md text. `dirName` (the folder, or file stem when flat) enables the name-matches-folder check. */
export function validateSkillText(raw: string, dirName?: string): Validation {
  const issues: Issue[] = []
  const out: Validation = { wouldLoad: false, modelInvocable: true, userInvocable: true, issues }
  const fm = parseFrontmatter(raw)
  if (!fm.ok) { issues.push(fm.issue); return out }
  const { data, body } = fm.value
  let loadable = true
  const name = typeof data.name === 'string' && data.name.length > 0 ? data.name : undefined
  const description = typeof data.description === 'string' && data.description.length > 0 ? data.description : undefined
  if (name === undefined) { issues.push({ level: 'error', code: 'name-missing', message: 'Frontmatter needs a non-empty string `name`.' }); loadable = false }
  if (description === undefined) { issues.push({ level: 'error', code: 'description-missing', message: 'Frontmatter needs a non-empty string `description`.' }); loadable = false }
  if (name !== undefined) {
    out.name = name
    if (!SKILL_NAME.test(name)) { issues.push({ level: 'error', code: 'name-invalid', message: `Name "${name}" must be lowercase kebab-case (a-z, 0-9, single hyphens).` }); loadable = false }
    if (name.length > NAME_MAX) issues.push({ level: 'warn', code: 'name-long', message: `Name is ${String(name.length)} characters; the Agent Skills spec allows ${String(NAME_MAX)}.` })
    if (dirName !== undefined && dirName !== name) issues.push({ level: 'warn', code: 'name-folder', message: `Name "${name}" differs from its folder "${dirName}". DSH does not mind; Claude Code and pi expect them to match.` })
  }
  if (description !== undefined) {
    out.description = description
    if (description.length > DESCRIPTION_MAX) issues.push({ level: 'warn', code: 'description-long', message: `Description is ${String(description.length)} characters; the Agent Skills spec allows ${String(DESCRIPTION_MAX)}.` })
    else if (description.length > CATALOG_DESCRIPTION_MAX) issues.push({ level: 'warn', code: 'description-catalog', message: `DSH truncates descriptions to ${String(CATALOG_DESCRIPTION_MAX)} characters in the model's skill catalog (this one has ${String(description.length)}).` })
  }
  if (typeof data.whenToUse === 'string' && data.whenToUse.length > 0) out.whenToUse = data.whenToUse
  for (const [legacy, canonical] of LEGACY_KEYS) {
    if (Object.hasOwn(data, legacy)) {
      issues.push({ level: 'error', code: 'legacy-key', message: `Frontmatter field "${legacy}" is unsupported by DSH (the skill is silently ignored); use "${canonical}".` })
      loadable = false
    }
  }
  const disableModel = boolish(data, 'disable-model-invocation')
  const userInv = boolish(data, 'user-invocable')
  if (disableModel === 'invalid') { issues.push({ level: 'error', code: 'bool-invalid', message: '`disable-model-invocation` must be a boolean.' }); loadable = false }
  if (userInv === 'invalid') { issues.push({ level: 'error', code: 'bool-invalid', message: '`user-invocable` must be a boolean.' }); loadable = false }
  out.modelInvocable = disableModel !== true
  out.userInvocable = userInv !== false
  const trimmed = body.trim()
  if (trimmed.length === 0) issues.push({ level: 'warn', code: 'body-empty', message: 'The skill body is empty.' })
  const lines = trimmed.length === 0 ? 0 : trimmed.split('\n').length
  if (lines > BODY_SOFT_LINES || Buffer.byteLength(trimmed) > BODY_SOFT_BYTES) {
    issues.push({ level: 'warn', code: 'body-long', message: `The body is long (${String(lines)} lines, ${String(Math.round(Buffer.byteLength(trimmed) / 1024))} KB). Keep SKILL.md focused and move detail into referenced files.` })
  }
  out.wouldLoad = loadable
  return out
}

/** Build a new SKILL.md. */
export function renderSkillTemplate(input: { name: string; description: string; body?: string }): string {
  const description = JSON.stringify(input.description.replace(/\s+/g, ' ').trim())
  const body = input.body?.trim() ?? `# ${input.name}\n\nDescribe when to use this skill and the steps to follow.\n`
  return `---\nname: ${input.name}\ndescription: ${description}\n---\n\n${body.endsWith('\n') ? body : `${body}\n`}`
}
