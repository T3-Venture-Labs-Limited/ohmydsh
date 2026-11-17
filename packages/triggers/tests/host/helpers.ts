import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_LIMITS, DEFAULT_MAX_EVENT_CHARS, type Automation, type Source, type Target } from '../../src/shared/types.ts'

export async function tempDir(prefix = 'triggers-'): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) }
}

export function automation(over: Partial<Omit<Automation, 'target'>> & { target?: Partial<Target>; source?: Source } = {}): Automation {
  const { target, ...rest } = over
  return {
    id: 'trg_test', name: 'Test automation', description: '', enabled: true,
    source: { kind: 'webhook', auth: 'token', events: [] },
    prompt: 'Handle this: {{event_fenced}}',
    limits: { ...DEFAULT_LIMITS }, maxEventChars: DEFAULT_MAX_EVENT_CHARS, createdAt: 0, updatedAt: 0, consecutiveFailures: 0,
    ...rest,
    target: { mode: 'new', cwd: '/tmp', model: null, sandbox: 'read-only', tools: 'read', title: '{{automation}}', ...target },
  }
}

export const log = { info: () => {}, warn: () => {} }

export async function until(cond: () => boolean | Promise<boolean>, timeoutMs = 5000, stepMs = 20): Promise<void> {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    if (await cond()) return
    await new Promise((r) => setTimeout(r, stepMs))
  }
  throw new Error('condition not met in time')
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
