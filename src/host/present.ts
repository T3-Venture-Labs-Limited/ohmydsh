// Pure helpers: DSH messages/usage -> Langfuse input/usageDetails/costDetails.
import { createHash } from 'node:crypto'
import type { Price } from './config.ts'

type Block = { type?: string; text?: string; id?: string; name?: string; arguments?: string; [key: string]: unknown }
interface Msg { role?: string; content?: unknown; toolCallId?: string; [key: string]: unknown }

export function blocksOf(content: unknown): Block[] {
  if (typeof content === 'string') return [{ type: 'text', text: content }]
  return Array.isArray(content) ? (content as Block[]) : []
}

export function textOf(content: unknown): string {
  return blocksOf(content).filter((b) => b.type === 'text' && typeof b.text === 'string').map((b) => b.text as string).join('\n')
}

export const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex')

export interface PresentOptions { includeReasoning: boolean; includeSystemPrompt: boolean }

/** Chat-shaped view of a request/message list that Langfuse renders natively. */
export function presentMessages(messages: readonly unknown[], opts: PresentOptions): unknown[] {
  return messages.map((raw) => {
    const m = raw as Msg
    const blocks = blocksOf(m.content)
    const text = textOf(m.content)
    if (m.role === 'system' && !opts.includeSystemPrompt) {
      return { role: 'system', content: `[system prompt omitted: ${text.length} chars, sha256 ${sha256(text).slice(0, 16)}]` }
    }
    if (m.role === 'tool') return { role: 'tool', tool_call_id: m.toolCallId, content: text }
    const toolCalls = blocks.filter((b) => b.type === 'tool-call').map((b) => ({ id: b.id, type: 'function', function: { name: b.name, arguments: b.arguments } }))
    const reasoning = opts.includeReasoning ? blocks.filter((b) => b.type === 'reasoning').map((b) => b.text ?? '').join('\n') : ''
    const others = blocks.filter((b) => b.type !== 'text' && b.type !== 'tool-call' && b.type !== 'reasoning')
    const out: Record<string, unknown> = { role: m.role, content: others.length > 0 ? [...(text ? [{ type: 'text', text }] : []), ...others.map(describeBlock)] : text }
    if (toolCalls.length > 0) out['tool_calls'] = toolCalls
    if (reasoning) out['reasoning_content'] = reasoning
    return out
  })
}

function describeBlock(b: Block): unknown {
  if (b.type === 'image') return { type: 'image', attachment: b['attachment'], offloaded: b['offloaded'] }
  return b
}

export interface TokenUsage { inputTokens?: number; outputTokens?: number; totalTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number; reasoningTokens?: number }

/** DSH reports reasoning inside outputTokens (as pi does); split it out only while it stays a subset. */
export function splitReasoning(usage: TokenUsage): { output: number; reasoning: number } {
  const out = usage.outputTokens ?? 0
  const reasoning = usage.reasoningTokens ?? 0
  return reasoning > 0 && reasoning <= out ? { output: out - reasoning, reasoning } : { output: out, reasoning: 0 }
}

export function usageDetails(usage: TokenUsage): Record<string, number> | undefined {
  const d: Record<string, number> = {}
  if ((usage.inputTokens ?? 0) > 0) d['input'] = usage.inputTokens as number
  const { output, reasoning } = splitReasoning(usage)
  if (output > 0) d['output'] = output
  if (reasoning > 0) d['output_reasoning_tokens'] = reasoning
  if ((usage.cacheReadTokens ?? 0) > 0) d['cache_read_input_tokens'] = usage.cacheReadTokens as number
  if ((usage.cacheWriteTokens ?? 0) > 0) d['cache_creation_input_tokens'] = usage.cacheWriteTokens as number
  return Object.keys(d).length > 0 ? d : undefined
}

/** Cost keys mirror the usage keys (Langfuse joins by name). Prices are USD per 1M tokens. */
export function costDetails(usage: TokenUsage, price: Price | undefined): Record<string, number> | undefined {
  if (price === undefined) return undefined
  const per = (tokens: number | undefined, rate: number | undefined): number => ((tokens ?? 0) * (rate ?? 0)) / 1e6
  const { output, reasoning } = splitReasoning(usage)
  const d: Record<string, number> = {}
  const add = (key: string, value: number): void => { if (value > 0) d[key] = value }
  add('input', per(usage.inputTokens, price.input))
  add('output', per(output, price.output))
  add('output_reasoning_tokens', per(reasoning, price.output))
  add('cache_read_input_tokens', per(usage.cacheReadTokens, price.cacheRead ?? price.input))
  add('cache_creation_input_tokens', per(usage.cacheWriteTokens, price.cacheWrite ?? price.input))
  const total = Object.values(d).reduce((a, b) => a + b, 0)
  if (total > 0) d['total'] = total
  return total > 0 ? d : undefined
}

export function findPrice(table: Record<string, Price>, provider: string, model: string): Price | undefined {
  return table[`${provider}/${model}`] ?? table[model]
}

export function safeJson(text: string): unknown {
  try { return JSON.parse(text) as unknown } catch { return text }
}

/** Ambient context messages that are not the human/automation input of a turn. */
export const AMBIENT_SOURCES = new Set([
  'runtime-context', 'time-context', 'working-directory', 'tmux-context', 'skill-catalog', 'agent-instructions', 'tool-registry',
  'model-selection', 'plan-mode', 'tool-goal', 'repeat-tool-reminder', 'user-approval', 'tool-jobs', 'action-cards', 'system-prompt',
])
