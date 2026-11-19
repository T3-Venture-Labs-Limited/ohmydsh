// Managed blocks between `# >>> ohmydsh` / `# <<< ohmydsh` markers. Everything outside a block is the user's.
import { OmdError } from './util.js'

export const BEGIN = '# >>> ohmydsh (managed by omd; edits inside this block are overwritten, put your own rows outside it)'
export const END = '# <<< ohmydsh'
const BEGIN_RE = /^# >>> ohmydsh\b.*$/m
const END_RE = /^# <<< ohmydsh\b.*$/m

export function hasBlock(text) {
  return BEGIN_RE.test(text) && END_RE.test(text)
}

/** The text currently inside the block, or null. */
export function readBlock(text) {
  const b = BEGIN_RE.exec(text)
  const e = END_RE.exec(text)
  if (!b || !e || e.index < b.index) return null
  return text.slice(b.index + b[0].length + 1, e.index)
}

const isEntryLine = (line) => line.trim() !== '' && !line.trim().startsWith('#') && line.trim() !== '[]'

/** A YAML list file with no entries must say `[]`; one with entries must not. */
function normalizeEmpty(text) {
  const lines = text.split('\n')
  const hasEntries = lines.some(isEntryLine)
  const stripped = lines.filter((l) => l.trim() !== '[]')
  if (hasEntries) return stripped.join('\n')
  const body = stripped.join('\n').replace(/\n*$/, '\n')
  return `${body}[]\n`
}

/**
 * Put `content` (YAML list rows, or any text) inside the managed block of `text`, creating the block at the top of
 * the file the first time so the user's own rows, which come after it, win. Rows outside the block are untouched.
 * @param {'list' | 'map'} kind  list: top-level patch rows (an empty file is `[]`); map: a plain YAML mapping file
 */
export function rewriteBlock(text, content, kind = 'list') {
  const body = content.replace(/\s+$/, '')
  const block = `${BEGIN}\n${body === '' ? '' : `${body}\n`}${END}`
  const b = BEGIN_RE.exec(text)
  const e = END_RE.exec(text)
  if (Boolean(b) !== Boolean(e) || (b && e && e.index < b.index)) throw new OmdError('the ohmydsh block markers are damaged (one is missing or they are out of order); fix or remove them by hand')
  let out
  if (b && e) out = `${text.slice(0, b.index)}${block}${text.slice(e.index + e[0].length)}`
  else out = `${block}\n${text.startsWith('\n') ? text.slice(1) : text}`
  out = out.replace(/\n{3,}/g, '\n\n')
  if (!out.endsWith('\n')) out += '\n'
  return kind === 'list' ? normalizeEmpty(out) : out
}

/** Remove the managed block (and nothing else). */
export function removeBlock(text, kind = 'list') {
  if (!hasBlock(text)) return text
  const b = BEGIN_RE.exec(text)
  const e = END_RE.exec(text)
  const out = `${text.slice(0, b.index)}${text.slice(e.index + e[0].length).replace(/^\n/, '')}`
  return kind === 'list' ? normalizeEmpty(out) : out
}

/**
 * Ids of the rows in a patch file: top-level `- id: x` rows and the rows directly inside a top-level `- insert:` list.
 * Ids nested deeper (for example the model list inside a provider row's config) are not rows and are skipped.
 */
export function rowIds(text) {
  const ids = []
  const ID_RE = /^(\s*)-\s+id:\s*['"]?([^'"\s#]+)/
  let inInsert = false
  let itemIndent = -1
  for (const line of text.split('\n')) {
    if (line.trim() === '' || line.trim().startsWith('#')) continue
    const indent = line.length - line.trimStart().length
    if (indent === 0) {
      inInsert = /^-\s+insert:\s*(#.*)?$/.test(line)
      itemIndent = -1
      const m = ID_RE.exec(line)
      if (m) ids.push(m[2])
      continue
    }
    if (!inInsert) continue
    if (itemIndent === -1 && line.trimStart().startsWith('- ')) itemIndent = indent
    const m = ID_RE.exec(line)
    if (m && indent === itemIndent) ids.push(m[2])
  }
  return ids
}

/** Top-level keys of a YAML mapping, outside our block (enough for the profile's pnpm-workspace.yaml). */
function topLevelKeys(text) {
  const out = new Set()
  for (const m of text.matchAll(/^([A-Za-z][\w-]*):/gm)) out.add(m[1])
  return out
}

/**
 * The profile's pnpm-workspace.yaml gets one managed block with reviewed install scripts and minimum-release-age
 * exclusions. A key the user already set outside the block is left alone (and reported).
 * @returns {{ text: string, warnings: string[] }}
 */
export function rewriteWorkspaceYaml(text, { allowBuilds, releaseAgeExclude }) {
  const outside = removeBlock(text, 'map')
  const keys = topLevelKeys(outside)
  const warnings = []
  const parts = []
  if (allowBuilds.length > 0) {
    if (keys.has('allowBuilds')) warnings.push('pnpm-workspace.yaml already has its own allowBuilds; add these by hand if installs need them: ' + allowBuilds.join(', '))
    else parts.push(`allowBuilds:\n${allowBuilds.map((n) => `  ${n}: true`).join('\n')}`)
  }
  if (releaseAgeExclude.length > 0) {
    if (keys.has('minimumReleaseAgeExclude')) warnings.push('pnpm-workspace.yaml already has its own minimumReleaseAgeExclude')
    else parts.push(`minimumReleaseAgeExclude:\n${releaseAgeExclude.map((n) => `  - '${n}'`).join('\n')}`)
  }
  return { text: rewriteBlock(text, parts.join('\n'), 'map'), warnings }
}
