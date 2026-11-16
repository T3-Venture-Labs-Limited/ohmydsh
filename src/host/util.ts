/** Small host helpers shared by the trigger modules. */
import { randomBytes } from 'node:crypto'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'

export const newId = (prefix: string): string => `${prefix}_${randomBytes(6).toString('hex')}${Date.now().toString(36).slice(-4)}`

export const dshHome = (): string => process.env['DSH_HOME'] ?? join(homedir(), '.dsh')

/** `~` / `~/x` -> absolute; relative paths are refused by the caller (returns undefined). */
export function expandHome(path: string): string | undefined {
  const trimmed = path.trim()
  if (trimmed === '') return undefined
  const expanded = trimmed === '~' ? homedir() : trimmed.startsWith('~/') ? join(homedir(), trimmed.slice(2)) : trimmed
  return isAbsolute(expanded) ? resolve(expanded) : undefined
}

/** Glob on a file NAME: `*`, `?`, `[abc]`, `{a,b}`. Everything else is literal. */
export function globToRegExp(glob: string): RegExp {
  let out = ''
  let depth = 0
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i] as string
    if (c === '*') out += '[^/]*'
    else if (c === '?') out += '[^/]'
    else if (c === '{') { depth++; out += '(?:' }
    else if (c === '}' && depth > 0) { depth--; out += ')' }
    else if (c === ',' && depth > 0) out += '|'
    else if (c === '[') {
      const end = glob.indexOf(']', i + 1)
      if (end === -1) out += '\\['
      else { const body = glob.slice(i + 1, end).replace(/\\/g, '\\\\'); out += `[${body.startsWith('!') ? `^${body.slice(1)}` : body}]`; i = end }
    } else out += c.replace(/[.+^$()|\\/\]]/g, '\\$&')
  }
  while (depth-- > 0) out += ')'
  return new RegExp(`^${out}$`)
}

export const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/** First header value (node lowercases names). */
export function header(headers: Record<string, string | string[] | undefined>, name: string): string | undefined {
  const v = headers[name.toLowerCase()]
  return Array.isArray(v) ? v[0] : v
}
