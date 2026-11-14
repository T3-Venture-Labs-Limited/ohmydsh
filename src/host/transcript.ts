// Condenses one session log into text for the reviewer. Design decision: tool CALLS are included, tool OUTPUTS never are.
// Everything is redacted first; system reminders, catalogs and injected skill bodies are dropped; sizes are capped.
import { redact } from './redact.ts'

interface EventLike { type?: string; seq?: number; time?: number; data?: Record<string, unknown> }
interface Block { type?: string; text?: string }

export interface Condensed {
  text: string
  userTurns: number
  toolCalls: number
  skillsUsed: string[]
  /** Highest event seq included. */
  lastSeq: number
  truncated: boolean
}

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)}…[+${String(s.length - n)} chars]` : s)
const blocksText = (content: unknown): string => {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return (content as Block[]).filter(b => b?.type === 'text' && typeof b.text === 'string').map(b => b.text!).join('\n')
}
const stripReminders = (s: string): string => s.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').replace(/<available_skills>[\s\S]*?<\/available_skills>/g, '').trim()

/** Short, informative rendering of a tool call's arguments: names and small scalar values, no big payloads. */
export function summarizeArguments(raw: unknown, max = 220): string {
  if (typeof raw !== 'string') return ''
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch { return clip(redact(raw), max) }
  if (typeof parsed !== 'object' || parsed === null) return clip(redact(String(parsed)), max)
  const parts: string[] = []
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    const s = typeof v === 'string' ? v : JSON.stringify(v)
    parts.push(`${k}=${clip(s.replace(/\s+/g, ' '), k === 'command' || k === 'js' || k === 'script' ? 160 : 70)}`)
  }
  const joined = redact(parts.join(' '))
  return joined.length > max ? `${joined.slice(0, max)}…` : joined
}

export function condenseSession(events: readonly EventLike[], maxChars: number): Condensed {
  const lines: string[] = []
  let userTurns = 0
  let toolCalls = 0
  let lastSeq = 0
  const skills = new Set<string>()
  for (const e of events) {
    const d = e.data
    if (e.type === 'user/message') {
      const source = (d as { source?: { kind?: string; name?: string } } | undefined)?.source
      const kind = source?.kind
      if (kind === 'skill-catalog' || kind === 'dsh-skill-studio') continue
      if (kind === 'skill-invocation') { if (typeof source?.name === 'string') skills.add(source.name); lines.push(`[user invoked skill /${source?.name ?? '?'}]`); lastSeq = e.seq ?? lastSeq; continue }
      if (kind !== undefined && kind !== 'user') continue
      const text = stripReminders(blocksText((d as { content?: unknown } | undefined)?.content))
      if (text.length === 0) continue
      userTurns += 1
      lines.push(`USER: ${clip(redact(text), 1000)}`)
      lastSeq = e.seq ?? lastSeq
    } else if (e.type === 'assistant/message') {
      const message = (d as { message?: { content?: unknown } } | undefined)?.message
      const text = stripReminders(blocksText(message?.content))
      if (text.length > 0) lines.push(`ASSISTANT: ${clip(redact(text), 500)}`)
      lastSeq = e.seq ?? lastSeq
    } else if (e.type === 'tool/call') {
      const name = typeof d?.name === 'string' ? d.name : '?'
      toolCalls += 1
      if (name === 'skill') {
        try { const n = (JSON.parse(String(d?.arguments)) as { name?: unknown }).name; if (typeof n === 'string') skills.add(n) } catch { /* ignore */ }
      }
      lines.push(`TOOL CALL ${name}(${summarizeArguments(d?.arguments)})`)
      lastSeq = e.seq ?? lastSeq
    }
    // tool/result events are deliberately skipped: outputs are never sent to the reviewer.
  }
  let text = lines.join('\n')
  let truncated = false
  if (text.length > maxChars) {
    truncated = true
    // Keep the beginning (the task) and the end (the outcome); drop the middle.
    const head = text.slice(0, Math.floor(maxChars * 0.45))
    const tail = text.slice(text.length - Math.floor(maxChars * 0.5))
    text = `${head}\n…[middle of the session omitted]…\n${tail}`
  }
  return { text, userTurns, toolCalls, skillsUsed: [...skills], lastSeq, truncated }
}
