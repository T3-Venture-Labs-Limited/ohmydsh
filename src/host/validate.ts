/** SaveRequest → Automation (shared by the page route and the `triggers_save` tool). Throws ValidationError. */
import { statSync } from 'node:fs'
import { homedir } from 'node:os'
import {
  DEFAULT_LIMITS, DEFAULT_MAX_EVENT_CHARS,
  type Automation, type ModelRoute, type SaveRequest, type Source, type Target, type WebhookAuth,
} from '../shared/types.ts'
import { expandHome, newId } from './util.ts'

export class ValidationError extends Error {}

type Json = Record<string, unknown>
const obj = (v: unknown): Json => (typeof v === 'object' && v !== null && !Array.isArray(v) ? v as Json : {})
const text = (v: unknown, max: number, field: string, required = false): string => {
  if (v === undefined || v === null || v === '') { if (required) throw new ValidationError(`${field} is required`); return '' }
  if (typeof v !== 'string') throw new ValidationError(`${field} must be a string`)
  if (v.length > max) throw new ValidationError(`${field} is longer than ${String(max)} characters`)
  return v
}
const int = (v: unknown, min: number, max: number, fallback: number, field: string): number => {
  if (v === undefined || v === null) return fallback
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new ValidationError(`${field} must be a number`)
  return Math.min(Math.max(Math.round(v), min), max)
}
const AUTHS: readonly WebhookAuth[] = ['token', 'hmac-sha256', 'standard-webhooks', 'none']

export function parseRoute(v: unknown): ModelRoute | null {
  if (v === null || v === undefined) return null
  const o = obj(v)
  if (typeof o['provider'] !== 'string' || o['provider'] === '' || typeof o['model'] !== 'string' || o['model'] === '') throw new ValidationError('model needs provider and model')
  return { provider: o['provider'], model: o['model'], ...(typeof o['reasoningEffort'] === 'string' && o['reasoningEffort'] !== '' ? { reasoningEffort: o['reasoningEffort'] } : {}) }
}

export function parseSource(v: unknown): Source {
  const o = obj(v)
  switch (o['kind']) {
    case 'webhook': {
      const auth = o['auth'] ?? 'token'
      if (!AUTHS.includes(auth as WebhookAuth)) throw new ValidationError(`source.auth must be one of ${AUTHS.join(', ')}`)
      const events = Array.isArray(o['events']) ? o['events'].filter((e): e is string => typeof e === 'string' && e.trim() !== '' && e.length <= 100).map((e) => e.trim()).slice(0, 50) : []
      return { kind: 'webhook', auth: auth as WebhookAuth, events }
    }
    case 'file': {
      const raw = text(o['path'], 1000, 'source.path', true)
      const path = expandHome(raw)
      if (path === undefined) throw new ValidationError('source.path must be an absolute directory (or start with ~/)')
      const pattern = text(o['pattern'], 200, 'source.pattern', true).trim()
      if (pattern.includes('/')) throw new ValidationError('source.pattern matches a file NAME and cannot contain "/"')
      const settleMs = int(o['settleMs'], 0, 600_000, 5000, 'source.settleMs')
      const sib = o['requireSibling']
      let requireSibling: { file: string; field: string; equals: string } | undefined
      if (sib !== undefined && sib !== null) {
        const s = obj(sib)
        const file = text(s['file'], 200, 'requireSibling.file', true).trim()
        if (file.includes('/')) throw new ValidationError('requireSibling.file is a file name next to the match')
        requireSibling = { file, field: text(s['field'], 200, 'requireSibling.field', true).trim(), equals: typeof s['equals'] === 'string' ? s['equals'] : JSON.stringify(s['equals'] ?? '') }
      }
      return { kind: 'file', path, pattern, settleMs, ignoreExisting: true, ...(requireSibling === undefined ? {} : { requireSibling }) }
    }
    case 'composio': {
      const triggerSlug = text(o['triggerSlug'], 120, 'source.triggerSlug', true).trim().toUpperCase()
      if (!/^[A-Z0-9_]+$/.test(triggerSlug)) throw new ValidationError('source.triggerSlug must look like GMAIL_NEW_GMAIL_MESSAGE')
      const inst = text(o['triggerInstanceId'], 200, 'source.triggerInstanceId').trim()
      const acct = text(o['connectedAccountId'], 200, 'source.connectedAccountId').trim()
      return { kind: 'composio', triggerSlug, ...(inst === '' ? {} : { triggerInstanceId: inst }), ...(acct === '' ? {} : { connectedAccountId: acct }) }
    }
    default: throw new ValidationError('source.kind must be webhook, file or composio')
  }
}

export function parseTarget(v: unknown, defaultCwd: string): Omit<Target, 'sessionId'> {
  const o = obj(v)
  const rawCwd = text(o['cwd'], 1000, 'target.cwd')
  const cwd = rawCwd === '' ? defaultCwd : expandHome(rawCwd)
  if (cwd === undefined) throw new ValidationError('target.cwd must be an absolute directory')
  const mode = o['mode'] ?? 'new'
  if (mode !== 'new' && mode !== 'reuse') throw new ValidationError('target.mode must be new or reuse')
  const sandbox = o['sandbox'] ?? 'read-only'
  if (sandbox !== 'read-only' && sandbox !== 'workspace-write') throw new ValidationError('target.sandbox must be read-only or workspace-write')
  const tools = o['tools'] ?? 'read'
  if (tools !== 'read' && tools !== 'standard') throw new ValidationError('target.tools must be read or standard')
  return { mode, cwd, model: parseRoute(o['model']), sandbox, tools, title: text(o['title'], 200, 'target.title') }
}

const isDir = (p: string): boolean => { try { return statSync(p).isDirectory() } catch { return false } }

/** Build the stored automation. `prior` keeps id, createdAt, enabled state, failures and the reuse chat when still valid. */
export function automationFrom(body: unknown, prior: Automation | undefined, defaultCwd: string, now = Date.now()): { automation: Automation; warnings: string[] } {
  const req = obj(body) as Partial<SaveRequest> & Json
  const name = text(req.name, 120, 'name', true).trim()
  if (name === '') throw new ValidationError('name is required')
  const prompt = text(req.prompt, 20_000, 'prompt', true)
  if (prompt.trim() === '') throw new ValidationError('prompt is required')
  const source = parseSource(req.source)
  const target = parseTarget(req.target, defaultCwd)
  const limits = obj(req.limits)
  const keepSession = prior?.target.sessionId !== undefined && prior.target.mode === 'reuse' && target.mode === 'reuse' && prior.target.cwd === target.cwd
  const automation: Automation = {
    id: prior?.id ?? newId('trg'),
    name,
    description: text(req.description, 2000, 'description'),
    enabled: typeof req.enabled === 'boolean' ? req.enabled : prior?.enabled ?? true,
    source,
    target: { ...target, ...(keepSession ? { sessionId: prior.target.sessionId } : {}) },
    prompt,
    limits: {
      maxPerHour: int(limits['maxPerHour'], 1, 600, prior?.limits.maxPerHour ?? DEFAULT_LIMITS.maxPerHour, 'limits.maxPerHour'),
      minIntervalSec: int(limits['minIntervalSec'], 0, 86_400, prior?.limits.minIntervalSec ?? DEFAULT_LIMITS.minIntervalSec, 'limits.minIntervalSec'),
    },
    maxEventChars: int(req.maxEventChars, 200, 100_000, prior?.maxEventChars ?? DEFAULT_MAX_EVENT_CHARS, 'maxEventChars'),
    createdAt: prior?.createdAt ?? now,
    updatedAt: now,
    consecutiveFailures: req.enabled === true ? 0 : prior?.consecutiveFailures ?? 0,
  }
  return { automation, warnings: warningsFor(automation) }
}

export function warningsFor(a: Automation): string[] {
  const out: string[] = []
  if (!isDir(a.target.cwd)) out.push(`The workspace directory ${a.target.cwd} does not exist yet.`)
  if (a.source.kind === 'file' && !isDir(a.source.path)) out.push(`The watched directory ${a.source.path} does not exist yet; it is picked up by the next scan (every 5 minutes) once created.`)
  if (a.source.kind === 'file' && (a.source.path === '/' || a.source.path === homedir())) out.push('Watching a whole home or root directory is expensive (every subdirectory is watched); pick the folder the files actually land in.')
  if (a.source.kind === 'webhook' && a.source.auth === 'none') out.push('Auth "none" accepts requests only directly from this machine (loopback, no proxy).')
  if (a.target.tools === 'standard') out.push('Tools "standard" lets a run started by third-party event text use every tool the chat has (sandbox and approvals still apply). Prefer "read" unless the automation must change files.')
  if (a.target.sandbox === 'workspace-write') out.push('Sandbox "workspace-write" lets the run write inside the workspace.')
  if (!/\{\{\s*event_fenced\s*\}\}/.test(a.prompt)) out.push('The prompt has no {{event_fenced}}; the event is appended at the end.')
  return out
}
