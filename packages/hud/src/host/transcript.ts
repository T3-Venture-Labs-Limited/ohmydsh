/**
 * Folds Harness session records into the compact entries the HUD draws.
 * Adapted from dsh-quorfloat's Rust transcript reducer (MIT, see NOTICE): same event vocabulary, trimmed to
 * user text, assistant text, one line per tool call, and turn/approval state. Reasoning is never forwarded.
 */

export type EntryKind = 'user' | 'assistant' | 'tool'

export interface Entry {
  readonly id: string
  readonly kind: EntryKind
  readonly text: string
  /** Tool name, for `kind: 'tool'`. */
  readonly name?: string
}

export type Update =
  | { readonly type: 'entry'; readonly entry: Entry }
  | { readonly type: 'status'; readonly running: boolean }
  | { readonly type: 'title'; readonly title: string }
  | { readonly type: 'approval'; readonly pending: boolean }
  | { readonly type: 'stream-clear' }

/** Per-record text cap (quorfloat uses 32 KiB too). */
export const MAX_TEXT = 32 * 1024
/** Entries kept per session window. */
export const MAX_ENTRIES = 80

const clip = (text: string): string => (text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}\n… (truncated)` : text)

interface Block { type?: unknown; text?: unknown; name?: unknown; arguments?: unknown }

function blocksOf(data: unknown): Block[] {
  const record = (typeof data === 'object' && data !== null ? data : {}) as { message?: { content?: unknown }; content?: unknown }
  // `user/message` content is NOT wrapped in `message`; the other record kinds are.
  const content = record.message?.content ?? record.content
  return Array.isArray(content) ? (content as Block[]).filter((b) => typeof b === 'object' && b !== null) : []
}

const textOf = (blocks: Block[]): string =>
  blocks.filter((b) => b.type === 'text' && typeof b.text === 'string').map((b) => b.text as string).join('\n')

function argumentSummary(args: unknown): string {
  if (typeof args !== 'string' || args === '') return ''
  try {
    const parsed = JSON.parse(args) as Record<string, unknown>
    const first = Object.values(parsed).find((v) => typeof v === 'string') as string | undefined
    return (first ?? args).replace(/\s+/g, ' ').slice(0, 120)
  } catch { return args.replace(/\s+/g, ' ').slice(0, 120) }
}

export class Transcript {
  entries: Entry[] = []
  cursor = -1
  running = false
  title = ''
  approval = false
  /** Live assistant stream blocks (index → text), reset on `start` and when the durable message lands. */
  private stream: string[] = []

  /** Fold one durable record. Returns the updates it caused (empty when it is a duplicate or machinery). */
  foldEvent(seq: number, type: string, data: unknown): Update[] {
    if (seq >= 0) {
      if (seq <= this.cursor) return []
      this.cursor = seq
    }
    const updates: Update[] = []
    const push = (kind: EntryKind, text: string, index: number, name?: string): void => {
      const entry: Entry = { id: `${String(seq)}-${String(index)}`, kind, text: clip(text), ...(name === undefined ? {} : { name }) }
      this.entries.push(entry)
      if (this.entries.length > MAX_ENTRIES) this.entries.splice(0, this.entries.length - MAX_ENTRIES)
      updates.push({ type: 'entry', entry })
    }
    switch (type) {
      case 'user/message': {
        this.stream = []
        const source = (data as { source?: { kind?: unknown } } | null)?.source?.kind
        // `runtime-context` and friends are Harness scaffolding, not what the user typed.
        if (source !== undefined && source !== 'user') return []
        const text = textOf(blocksOf(data))
        if (text !== '') push('user', text, 0)
        break
      }
      case 'assistant/message': {
        this.stream = []
        updates.push({ type: 'stream-clear' })
        const blocks = blocksOf(data)
        const text = textOf(blocks)
        let index = 0
        if (text !== '') push('assistant', text, index++)
        for (const block of blocks) {
          if (block.type !== 'tool-call') continue
          push('tool', argumentSummary(block.arguments), index++, typeof block.name === 'string' ? block.name : 'tool')
        }
        break
      }
      case 'turn/start':
        this.running = true
        updates.push({ type: 'status', running: true })
        break
      case 'turn/end':
        this.running = false
        this.stream = []
        updates.push({ type: 'stream-clear' }, { type: 'status', running: false })
        break
      case 'session/title': {
        const title = (data as { title?: unknown } | null)?.title
        if (typeof title === 'string' && title !== '') { this.title = title; updates.push({ type: 'title', title }) }
        break
      }
      case 'approval/asked':
        this.approval = true
        updates.push({ type: 'approval', pending: true })
        break
      case 'approval/decided':
        this.approval = false
        updates.push({ type: 'approval', pending: false })
        break
      default:
        break
    }
    return updates
  }

  /** Fold a snapshot's records without emitting per-entry updates. */
  foldRecords(records: readonly unknown[], cursor: number): void {
    this.entries = []
    this.stream = []
    this.running = false
    this.approval = false
    this.cursor = -1
    for (const record of records) {
      const event = (record as { event?: { seq?: unknown; type?: unknown; data?: unknown } } | null)?.event
      if (event === undefined || typeof event.type !== 'string') continue
      this.foldEvent(typeof event.seq === 'number' ? event.seq : -1, event.type, event.data)
    }
    if (cursor > this.cursor) this.cursor = cursor
  }

  /** Fold one ephemeral assistant-stream frame; returns the full live text when it changed. */
  foldStream(frame: unknown): string | undefined {
    const f = (typeof frame === 'object' && frame !== null ? frame : {}) as { type?: unknown; chunk?: { type?: unknown; index?: unknown; text?: unknown; blockType?: unknown }; index?: unknown }
    if (f.type === 'start') { this.stream = []; return '' }
    if (f.type !== 'chunk' || f.chunk === undefined) return undefined
    const chunk = f.chunk
    const index = typeof chunk.index === 'number' ? chunk.index : typeof f.index === 'number' ? f.index : 0
    if (chunk.type === 'block-start') {
      // Reasoning and tool-call blocks are never drawn; only text blocks open a live slot.
      if (chunk.blockType === undefined || chunk.blockType === 'text') this.stream[index] = ''
      return this.liveText()
    }
    if (chunk.type === 'text-delta' && typeof chunk.text === 'string') {
      this.stream[index] = (this.stream[index] ?? '') + chunk.text
      return this.liveText()
    }
    return undefined
  }

  liveText(): string {
    return clip(this.stream.filter((t) => typeof t === 'string').join('\n\n'))
  }
}
