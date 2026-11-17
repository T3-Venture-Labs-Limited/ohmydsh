// Test harness for the Triggers page: a dictionary-backed `t`, a routed fake `fetch`, render + DOM helpers.
import { act } from 'react'
import type { ReactElement } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { vi } from 'vitest'
import { locale } from '../../src/client/locale.ts'
import type { T } from '../../src/client/locale.ts'
import type { AutomationView, RunRow, TriggersState } from '../../src/shared/types.ts'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

export const t = ((key: string, params?: Record<string, unknown>): string =>
  (locale.en as Record<string, string>)[key]?.replace(/\{(\w+)\}/g, (_m, k: string) => String(params?.[k] ?? '')) ?? key) as unknown as T

export type Handler = (body: Record<string, unknown>) => unknown
export interface FakeApi { calls: { method: string; body: Record<string, unknown> }[]; fetch: ReturnType<typeof vi.fn>; of(method: string): Record<string, unknown>[] }

/** Stub `fetch` for `api/triggers/<method>`; a handler's return value becomes `{ ok: true, value }`, a throw an error envelope. */
export function fakeApi(handlers: Record<string, Handler>): FakeApi {
  const calls: FakeApi['calls'] = []
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    const match = /^api\/triggers\/(\w+)$/.exec(url)
    const method = match?.[1] ?? '?'
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
    calls.push({ method, body })
    const handler = handlers[method]
    if (handler === undefined) return new Response(JSON.stringify({ ok: false, error: { code: 'not-found', message: `no route ${method}` } }), { status: 404 })
    try { return new Response(JSON.stringify({ ok: true, value: handler(body) })) } catch (e) {
      return new Response(JSON.stringify({ ok: false, error: { code: 'bad', message: e instanceof Error ? e.message : String(e) } }), { status: 400 })
    }
  })
  vi.stubGlobal('fetch', fetch)
  return { calls, fetch, of: (method) => calls.filter((c) => c.method === method).map((c) => c.body) }
}

export async function flush(ms = 0): Promise<void> {
  await act(async () => { await new Promise((r) => setTimeout(r, ms)) })
}

export async function render(node: ReactElement): Promise<{ host: HTMLElement; root: Root; unmount: () => void }> {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => { root.render(node) })
  await flush()
  await flush()
  return { host, root, unmount: () => { act(() => { root.unmount() }); host.remove() } }
}

export async function click(el: Element | null | undefined): Promise<void> {
  if (el === null || el === undefined) throw new Error('click: element not found')
  await act(async () => { (el as HTMLElement).click() })
  await flush()
  await flush()
}

/** Set a React-controlled input / textarea / select value and fire the event React listens to. */
export async function type(el: Element | null | undefined, value: string): Promise<void> {
  if (el === null || el === undefined) throw new Error('type: element not found')
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
  await act(async () => {
    setter?.call(el, value)
    el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }))
  })
}

/** The control labelled `label` (label text match, exact). */
export function field(label: string, root: ParentNode = document): HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement {
  const lab = [...root.querySelectorAll('label')].find((l) => l.textContent === label)
  const id = lab?.getAttribute('for')
  const el = id === null || id === undefined ? null : document.getElementById(id)
  if (el === null) throw new Error(`field not found: ${label}`)
  return el as HTMLInputElement
}

export function button(text: string, root: ParentNode = document): HTMLButtonElement {
  const el = [...root.querySelectorAll('button')].find((b) => b.textContent === text || b.getAttribute('aria-label') === text)
  if (el === undefined) throw new Error(`button not found: ${text}`)
  return el
}

export function tab(groupLabel: string, text: string): HTMLButtonElement {
  const list = [...document.querySelectorAll('[role="tablist"]')].find((l) => l.getAttribute('aria-label') === groupLabel)
  const el = [...(list?.querySelectorAll('[role="tab"]') ?? [])].find((b) => b.textContent === text)
  if (el === undefined) throw new Error(`tab not found: ${groupLabel} / ${text}`)
  return el as HTMLButtonElement
}

// ---------------- fixtures ----------------

export function run(over: Partial<RunRow> = {}): RunRow {
  return { runId: 'r1', automationId: 'a1', automationName: 'Deploy hook', at: Date.now() - 120_000, source: 'webhook', eventId: 'e1', summary: 'POST from 127.0.0.1', bytes: 42, status: 'delivered', sessionId: 'sess-1', model: 'claude/claude-sonnet-5-5', ...over }
}

export function automation(over: Partial<AutomationView> = {}): AutomationView {
  return {
    id: 'a1', name: 'Deploy hook', description: '', enabled: true,
    source: { kind: 'webhook', auth: 'token', events: [] },
    target: { mode: 'new', cwd: '/home/me/proj', model: { provider: 'claude', model: 'claude-sonnet-5-5' }, sandbox: 'read-only', tools: 'read', title: '{{automation}}' },
    prompt: 'Summarise.\n\n{{event_fenced}}', limits: { maxPerHour: 12, minIntervalSec: 10 }, maxEventChars: 12000,
    createdAt: 1, updatedAt: 1, consecutiveFailures: 0,
    webhookUrl: 'http://127.0.0.1:3080/hooks/a1', secretHint: 'whsec_ab…9f', lastRun: null, ...over,
  }
}

export function state(over: Partial<TriggersState> = {}): TriggersState {
  return {
    paused: false, automations: [], runs: [], origin: 'http://127.0.0.1:3080', hasAutomationModels: true, hasComposio: false,
    workspaces: [{ path: '/home/me/proj', title: 'proj' }, { path: '/home/me/notes', title: 'notes' }], defaultCwd: '/home/me/proj', ...over,
  }
}

export const catalog = {
  default: { provider: 'claude', model: 'claude-sonnet-5-5' },
  groups: [
    { id: 'claude', name: 'Claude', models: [
      { id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5', reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'medium', name: 'Medium' }, { id: 'high', name: 'High' }], defaultEffort: 'medium' } },
      { id: 'claude-haiku-5', name: 'Claude Haiku 5' },
    ] },
    { id: 'deepseek', name: 'DeepSeek', models: [{ id: 'deepseek-v4', name: 'DeepSeek V4' }] },
  ],
  routableProviders: ['claude', 'deepseek'], failures: [],
}
