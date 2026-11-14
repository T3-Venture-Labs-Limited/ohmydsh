/** Live, credential-free instructions for the conversation model's image tools. */
import { activeComfyUIWorkflow, resolveComfyUIWorkflows, type Config } from './config.js'
import { comfyUIWorkflowSlots } from './comfyui-workflow.js'

/** Workflow names listed for the model; a long list is cut so the system prompt stays small. */
const MAX_LISTED_WORKFLOWS = 20

/**
 * The ComfyUI workflows the `workflow` argument accepts (#98). Names are user
 * text, so each is JSON-quoted; the list stays absent without workflows.
 */
function comfyUIWorkflowLine(config: Config): string[] {
  const workflows = resolveComfyUIWorkflows(config)
  if (workflows.length === 0) return []
  const listed = workflows.slice(0, MAX_LISTED_WORKFLOWS).map(workflow => `${JSON.stringify(workflow.name)}${slotNote(workflow.json)}`).join(', ')
  const more = workflows.length > MAX_LISTED_WORKFLOWS ? ` (+${String(workflows.length - MAX_LISTED_WORKFLOWS)} more)` : ''
  const active = activeComfyUIWorkflow(config)
  return [`ComfyUI workflows available for the workflow argument (provider=comfyui): ${listed}${more}; active: ${JSON.stringify(active?.name ?? '')}. Pass workflow only when the user asks for a specific one; the local ComfyUI server may not be running. A workflow marked [N images] runs through studio_edit with exactly N source images; only one marked [size] honours size/aspect_ratio.`]
}

/** What a workflow takes from a call, so the model picks generate vs edit and the image count. */
function slotNote(json: string): string {
  let slots
  try { slots = comfyUIWorkflowSlots(json) } catch { return '' }
  const parts = [
    ...(slots.images > 0 ? [`${String(slots.images)} image${slots.images === 1 ? '' : 's'}`] : []),
    ...(slots.size ? ['size'] : []),
  ]
  return parts.length === 0 ? '' : ` [${parts.join(', ')}]`
}

export function imageToolContext(config: Config, configuredProviders?: readonly string[]): string {
  const provider = config.provider ?? 'google'
  const configured = configuredProviders === undefined ? undefined : [...configuredProviders]
  if (configured !== undefined && !configured.includes('comfyui') && resolveComfyUIWorkflows(config).length > 0) configured.push('comfyui')
  return [
    `Studio image and video tools: studio_make (generate, edit, inpaint, outpaint via expand, upscale, animate, restyle, extend), studio_models, studio_job, studio_gallery. Default provider: ${provider}.`,
    ...(configured === undefined ? [] : [`Configured providers (key saved, subscription signed in, or ComfyUI workflow present): ${configured.length > 0 ? configured.join(', ') : 'none'}. Do not select unlisted providers; configuration does not guarantee the service is reachable.`]),
    ...comfyUIWorkflowLine(config),
    'Unless the user names a provider or model, OMIT provider and model from studio_make: Studio picks the best configured model for the operation. Call studio_models first only when the user asks for a specific capability (inpaint, upscale, video, first/last frame) or you need the accepted params.',
    'Omit unused optional arguments entirely; never fill them with empty strings. Results are saved in the Studio gallery; use the returned asset ids as source/references/mask in later calls. Video takes minutes: do not wait unless asked, use studio_job.',
    'Minimal calls: studio_make({"op":"generate","prompt":"a sailboat"}); studio_make({"op":"edit","prompt":"make the sail blue"}) edits the newest image in the conversation unless source, source_attachment_id or source_path says otherwise.',
  ].join('\n')
}
