// Minimal structural types for the host services we touch. We import no @deepseek-ai packages at runtime.
import type { Anchor } from './types.ts'

export interface QuoteSummary { label: string; title: string; detail?: string; body: string }

/** The slice of InputActions (a standard slot prop) and SessionInput we use. */
export interface InputActionsLike {
  insertQuote(text: string, summary?: QuoteSummary): boolean
}

export interface Ctx {
  effect(fn: () => void | (() => void), name?: string): void
  get(name: string): unknown
  inject(names: string[], fn: (ctx: { get(name: string): unknown }) => void | (() => void)): void
  slots: {
    inject(name: string, fn: () => (() => void) | void): () => void
    register(options: Record<string, unknown>, component: unknown): () => void
  }
  locale: { register(ns: string, locale: string, dict: Record<string, string>): () => void; bind(ns: string): (key: string, params?: Record<string, unknown>) => string }
  sessions: { list: { getSnapshot(): unknown; subscribe(fn: () => void): () => void } }
}

export interface SidebarRightLike {
  openTab?(kind: string, options?: Record<string, unknown>): void
  openResourceIn?(sessionId: string, address: string, options?: { params?: Record<string, unknown> }): void
  openResource?(address: string, options?: { params?: Record<string, unknown> }): void
}

export function sidebarRightOf(ctx: Ctx): SidebarRightLike | undefined {
  try { return ctx.get('sidebarRight') as SidebarRightLike | undefined } catch { return undefined }
}

/** Current on-screen session id: the list snapshot when it carries one, else the conversation DOM marker. */
export function currentSessionId(ctx: Ctx): string {
  try {
    const current = (ctx.sessions.list.getSnapshot() as { current?: unknown }).current
    if (typeof current === 'string' && current !== '') return current
  } catch { /* fall through to the DOM */ }
  return document.querySelector<HTMLElement>('[data-conversation-session]')?.dataset.conversationSession ?? ''
}

export interface PageReadResult { ok: boolean; value?: { text: string; lines: number; eof: boolean; offset: number } }

/**
 * Read a workspace text file through the host Remote (the same call documentpreview uses).
 * Used only to find approximate source lines for rendered markdown; never throws.
 */
export async function readSource(ctx: Ctx, sessionId: string, path: string): Promise<string | null> {
  try {
    const remote = ctx.get('remote') as { workspaceFiles?: { read(sessionId: string, path: string, range: { offset: number }, signal?: AbortSignal): Promise<PageReadResult> } } | undefined
    const read = remote?.workspaceFiles?.read?.bind(remote.workspaceFiles)
    if (read === undefined) return null
    const pages: string[] = []
    let offset = 1
    for (let i = 0; i < 40; i += 1) {
      const page = await read(sessionId, path, { offset })
      if (!page.ok || page.value === undefined) return pages.length === 0 ? null : pages.join('\n')
      pages.push(page.value.text)
      if (page.value.eof || page.value.lines === 0) break
      offset += page.value.lines
    }
    return pages.join('\n')
  } catch { return null }
}

export type { Anchor }
