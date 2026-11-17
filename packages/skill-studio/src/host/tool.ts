// The model-facing `propose_skill` tool. Non-blocking: it validates and QUEUES a proposal for the user's review and returns at once.
// It has no write path to any skill root: approval happens in the Skills page / turn card, in a route the model cannot call.
import { defineTool } from '@deepseek-ai/dsh-tools'
import { ProposalError, type EnqueueInput } from './proposals.ts'

export interface ToolDeps {
  enabled(): boolean
  enqueue(input: EnqueueInput, sessionId: string): Promise<{ id: string; kind: string; name: string }>
}

export const PROPOSE_TOOL = 'propose_skill'

export function createProposeSkillTool(deps: ToolDeps) {
  return defineTool({
    name: PROPOSE_TOOL,
    description: 'Suggest saving a reusable procedure as an Agent Skill, or improving an existing one, after you notice something worth keeping (a multi-step recipe, a project convention, a gotcha plus its fix, a correction the user gave you). '
      + 'It only QUEUES the suggestion for the user to review; nothing is written until they approve, so call it at most once or twice per task, then continue your work. '
      + 'Pass the COMPLETE SKILL.md text (YAML frontmatter with name and description, then concise Markdown steps). Do not include secrets. Do not propose one-off facts or what existing skills already cover.',
    parameters: {
      action: { type: 'string', required: true, enum: ['new', 'improve'], description: '"new" for a new skill, "improve" to replace an existing skill with an updated full SKILL.md.' },
      name: { type: 'string', required: true, description: 'Skill name, lowercase kebab-case; must equal the frontmatter name. For improve, the existing skill name.' },
      content: { type: 'string', required: true, description: 'Complete SKILL.md including frontmatter.' },
      rationale: { type: 'string', required: true, description: 'One or two sentences: why this is worth keeping and what in this session shows it.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { queued: { type: 'boolean', required: true }, id: { type: 'string' }, message: { type: 'string', required: true } } },
      render: (_args, value) => [{ type: 'text', text: value.message }],
    },
    async execute(args, exec) {
      if (!deps.enabled()) return { queued: false, message: 'Skill proposals are switched off in Skill studio settings.' }
      const sessionId = exec.agent?.id === undefined ? 'unknown' : String(exec.agent.id)
      try {
        const queued = await deps.enqueue({
          origin: { kind: 'tool', sessionId, callId: String(exec.callId) },
          action: args.action === 'improve' ? 'improve' : 'new', name: String(args.name), content: String(args.content), rationale: String(args.rationale),
          evidence: [{ sessionId }],
        }, sessionId)
        return { queued: true, id: queued.id, message: `Queued as a proposal for the user's review (${queued.kind} skill "${queued.name}"). Nothing is written until they approve it in the Skills page. Continue with your task.` }
      } catch (error) {
        if (error instanceof ProposalError) return { queued: false, message: error.message }
        throw error
      }
    },
    presentCall(args) {
      return { card: 'generic', title: `Propose skill ${String(args.name)}`, kind: 'other', rawInput: String(args.name) }
    },
  })
}
