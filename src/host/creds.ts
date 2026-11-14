/**
 * Credentials come from the Composio CLI login (`~/.composio/user_data.json`) and are read at use time, never copied
 * or stored by this plugin. The user key is a USER-level key (it can list orgs and projects): it stays on the host and
 * is never sent to the browser, put in a prompt, an event or a log line. The consumer project id comes from the CLI's
 * own cache file.
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export interface Creds { apiKey: string; baseUrl: string; orgId: string; projectId: string; consumerUserId: string }

export class CredsError extends Error {
  constructor(readonly code: 'not-logged-in' | 'no-project', message: string) { super(message) }
}

const readJson = (path: string): Record<string, unknown> => JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>

export function readCreds(home: string = join(homedir(), '.composio')): Creds {
  let user: Record<string, unknown>
  try { user = readJson(join(home, 'user_data.json')) } catch { throw new CredsError('not-logged-in', 'The Composio CLI is not logged in (run `composio login`).') }
  const apiKey = user['api_key']; const orgId = user['org_id']
  if (typeof apiKey !== 'string' || typeof orgId !== 'string') throw new CredsError('not-logged-in', 'The Composio CLI login is incomplete (run `composio login`).')
  const baseUrl = typeof user['base_url'] === 'string' ? user['base_url'] : 'https://backend.composio.dev'
  let entries: Record<string, { orgId?: string; projectId?: string; consumerUserId?: string }> = {}
  try { entries = (readJson(join(home, 'tool-permissions-cache.json'))['entries'] ?? {}) as typeof entries } catch { /* handled below */ }
  const entry = Object.values(entries).find((e) => e.orgId === orgId && typeof e.projectId === 'string')
  if (entry?.projectId === undefined || entry.consumerUserId === undefined) throw new CredsError('no-project', 'No consumer project cached yet: run any `composio` command (for example `composio connections list`) once.')
  return { apiKey, baseUrl, orgId, projectId: entry.projectId, consumerUserId: entry.consumerUserId }
}

/** Strip anything that could be the key from an error text. */
export const redact = (text: string, creds?: Pick<Creds, 'apiKey'>): string => (creds === undefined ? text : text.split(creds.apiKey).join('<redacted>')).replace(/uak_[A-Za-z0-9_-]+/g, '<redacted>')
