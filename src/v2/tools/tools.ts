/**
 * Model-facing v2 tools: studio_make (any operation), studio_job, studio_gallery, studio_models.
 * Design: compact schemas, capped output, results as attachments/paths (never base64), session permission respected
 * (writes happen only inside the Studio store and, when asked, the session workspace), long jobs mirrored into ctx.jobs.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { defineTool, type ToolResult } from '@deepseek-ai/dsh-tools'
import { AdapterError, ACTIVE_JOB_STATES, type ProviderId, capabilitiesFor, mediaKindOf, type AssetRecord, type JobRecord, type MediaKind, type Operation } from '../contracts.js'
import type { StudioCore } from '../core.js'
import { parseOperationRequest } from '../request.js'
import { expandCanvas } from '../assets/masks.js'
import { HttpError } from '../routes/http.js'

const MAX_TEXT = 6000
const clip = (s: string, n = 300): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s)
const usd = (n: number | undefined): string => (n === undefined ? 'unknown' : n === 0 ? '$0 (included)' : `$${n < 0.01 ? n.toFixed(4) : n.toFixed(2)}`)

export function describeAsset(a: AssetRecord): string {
  const dims = a.width !== undefined && a.height !== undefined ? ` ${String(a.width)}x${String(a.height)}` : ''
  const dur = a.durationMs === undefined ? '' : ` ${(a.durationMs / 1000).toFixed(1)}s`
  return `${a.id} [${a.kind}${dims}${dur}] ${a.modelId ?? a.source}${a.prompt === undefined ? '' : ` — "${clip(a.prompt, 90)}"`}${a.favorite ? ' ★' : ''}${a.tags.length > 0 ? ` #${a.tags.join(' #')}` : ''}`
}

function jobLine(job: JobRecord): string {
  const bits = [`${job.id} ${job.state}`, job.modelId]
  if (job.progress !== undefined && job.state === 'running') bits.push(`${String(Math.round(job.progress * 100))}%`)
  if (job.message !== undefined && !['succeeded', 'failed'].includes(job.state)) bits.push(job.message)
  if (job.estimateUsd !== undefined && job.costUsd === undefined) bits.push(`est ${usd(job.estimateUsd)}`)
  if (job.costUsd !== undefined) bits.push(`cost ${usd(job.costUsd)} (${job.costSource ?? 'estimate'})`)
  if (job.error !== undefined) bits.push(`${job.error.kind}: ${clip(job.error.message, 240)}`)
  if (job.assetIds.length > 0) bits.push(`assets: ${job.assetIds.join(', ')}`)
  return bits.join(' | ')
}


const ATTACHMENT_SCHEMA = { type: 'object', additionalProperties: false, properties: {
  attachmentId: { type: 'string', required: true }, mediaType: { type: 'string', required: true }, bytes: { type: 'integer', required: true }, width: { type: 'integer', required: true }, height: { type: 'integer', required: true }, name: { type: 'string' },
  originalDimensions: { type: 'object', additionalProperties: false, properties: { width: { type: 'integer', required: true }, height: { type: 'integer', required: true } } },
} } as const

/** Output contract shared by studio_make / studio_job / studio_gallery / studio_models. */
const RESULT_OUTPUT = {
  schema: { type: 'object', additionalProperties: false, properties: {
    text: { type: 'string', required: true }, jobId: { type: 'string' }, state: { type: 'string' }, assetIds: { type: 'array', items: { type: 'string' } },
    attachments: { type: 'array', items: ATTACHMENT_SCHEMA },
  } },
  render: (_args: unknown, value: { text: string; attachments?: ImageAttachmentRef[] }) => [
    { type: 'text' as const, text: value.text },
    ...(value.attachments ?? []).map(attachment => ({ type: 'image' as const, attachment })),
  ],
} as const

interface V2Result { text: string; jobId?: string; state?: string; assetIds?: string[]; attachments?: ImageAttachmentRef[] }

export interface ReferenceSelectors { source_attachment_id?: string; source_attachment_ids?: string[]; source_path?: string; source_paths?: string[] }
interface ToolEnv {
  ctx: Context; core: StudioCore
  sessionOf(exec: unknown): string | undefined
  attachImage?(asset: AssetRecord): Promise<ImageAttachmentRef | undefined>
  /** Resolve conversation attachments, or workspace files to image bytes (the legacy studio_edit sources). */
  resolveReferences?(selectors: ReferenceSelectors, exec: unknown): Promise<{ data: Uint8Array; mediaType: string }[]>
  /** The user's configured default provider, preferred when no provider/model is given. */
  defaultProvider?(): ProviderId | undefined
  /** Copy a produced image into the session workspace when the user enabled it; returns the saved path. */
  saveToWorkspace?(ref: ImageAttachmentRef, bytes: Uint8Array, exec: unknown): Promise<{ path?: string; error?: string }>
}

export function registerV2Tools(env: ToolEnv): void {
  const { ctx, core } = env
  const jobsService = (): { start(spec: unknown): string } | undefined => ctx.get('jobs' as never) as { start(spec: unknown): string } | undefined

  ctx.tools.register(defineTool({
    name: 'studio_models',
    description: 'List the image/video models Studio can use right now, with capabilities, accepted parameters and price estimates. Call before studio_make when the user asks for a specific kind of result (inpaint, upscale, video, first/last frame) or a specific model. Only configured providers are listed unless all=true.',
    parameters: {
      capability: { type: 'string', enum: ['t2i', 'i2i', 'inpaint', 'upscale-image', 't2v', 'i2v', 'v2v', 'extend', 'upscale-video', 'first-last-frame'], description: 'Only models with this capability.' },
      all: { type: 'boolean', description: 'Include models of providers that have no API key yet (they cannot be run).' },
      limit: { type: 'integer', description: 'Maximum models to list, 1-40 (default 15).' },
    },
    output: RESULT_OUTPUT,
    async execute(args): Promise<V2Result> {
      const models = await core.registry.listModels({ ...(args.capability === undefined ? {} : { capability: args.capability as never }), configuredOnly: args.all !== true })
      const limit = Math.min(40, Math.max(1, args.limit ?? 15))
      const ranked = [...models].sort((a, b) => Number(b.curated) - Number(a.curated) || (a.tier === 'quality' ? -1 : 0) - (b.tier === 'quality' ? -1 : 0))
      const lines = ranked.slice(0, limit).map(m => {
        const params = m.params.slice(0, 6).map(p => p.type === 'enum' ? `${p.key}=${p.values.slice(0, 6).join('|')}${p.values.length > 6 ? '|…' : ''}` : `${p.key}:${p.type}`).join(', ')
        const price = m.pricing === undefined ? '' : ` ~${usd(m.pricing.usd)}/${m.pricing.unit}`
        return `${m.id} — ${m.label} [${m.capabilities.join(',')}]${price}${m.tier === undefined ? '' : ` (${m.tier})`}${params === '' ? '' : `\n    params: ${params}`}`
      })
      const configured = await core.registry.configuredProviders()
      const head = `Configured providers: ${configured.length === 0 ? 'none — ask the user to add an API key in Settings > Plugins > Studio' : configured.join(', ')}. ${String(models.length)} model(s)${models.length > limit ? `, showing ${String(limit)}` : ''}.`
      return { text: clip([head, ...lines].join('\n'), MAX_TEXT) }
    },
  }))

  const makeParams = {
    op: { type: 'string', enum: ['generate', 'edit', 'inpaint', 'upscale', 'animate', 'restyle', 'extend'], required: true, description: 'generate: new image/video from text (optionally with references or first/last frame). edit: change an existing image. inpaint: repaint a masked area. upscale: enlarge an image or video. animate: turn an image into a video. restyle: change a video. extend: continue a video.' },
    model: { type: 'string', description: 'Model id from studio_models (provider:model). OMIT to let Studio pick the best configured model for the operation.' },
    prompt: { type: 'string', description: 'What to create or change. Required for generate/edit/inpaint/animate/restyle/extend.' },
    negative_prompt: { type: 'string', description: 'What to avoid (only models that support it).' },
    source: { type: 'string', description: 'Asset id of the image or video to operate on (from studio_gallery or a previous result).' },
    source_attachment_id: { type: 'string', description: 'Attachment id of an image already in this conversation (uploaded or generated). It is stored in the gallery and used as the source (edit/inpaint/animate) or as a reference (generate).' },
    source_attachment_ids: { type: 'array', items: { type: 'string' }, description: 'Ordered attachment ids of several conversation images; the first is the source, the rest are references. "image 1" / "image 2" in the prompt follow this order.' },
    source_path: { type: 'string', description: 'Absolute or workspace-relative path of an image file inside the session workspace. Prefer it when the user names a file.' },
    source_paths: { type: 'array', items: { type: 'string' }, description: 'Ordered paths of several image files in the session workspace.' },
    prompts: { type: 'array', items: { type: 'string' }, description: 'Batch: 1-10 prompts, one result each, run in order with the same settings. Use instead of prompt for variations or illustration sets.' },
    provider: { type: 'string', description: 'OMIT unless the user names a provider. Restrict the model choice to one provider (openrouter, replicate, google, grok-sub, google-sub, comfyui, openai, openai-compat, xai).' },
    references: { type: 'array', items: { type: 'string' }, description: 'Extra reference image asset ids.' },
    mask: { type: 'string', description: 'Asset id of a mask image for inpaint. White marks the area to change. Masks are resized to the source and inverted per model automatically.' },
    expand: { type: 'object', additionalProperties: true, properties: {}, description: 'Outpaint: grow the source canvas before filling it. {"left":N,"right":N,"top":N,"bottom":N} in pixels (at least one). Studio extends the image, builds the mask for the new area and runs an inpaint with the prompt. Use op "inpaint"; omit mask.' },
    last_frame: { type: 'string', description: 'Asset id of the final frame image for animate (first/last frame videos).' },
    params: { type: 'object', additionalProperties: true, properties: {}, description: 'Model parameters from studio_models, e.g. {"aspect_ratio":"16:9","duration":"6","resolution":"720p"}.' },
    wait: { type: 'boolean', description: 'Wait for the result (default true for images, false for video: use studio_job to check).' },
    run_in_background: { type: 'boolean', description: 'Register the job as a background job (job_output / job_kill) instead of waiting.' },
    tags: { type: 'array', items: { type: 'string' }, description: 'Tags to store with the result.' },
  } as const

  ctx.tools.register(defineTool({
    name: 'studio_make',
    description: 'Create or transform an image or video with Studio (replaces studio_generate, studio_edit and studio_generate_batch): generate, edit, inpaint (mask), upscale, animate (image to video), restyle or extend video. Results are saved in the Studio gallery (content-addressed, with lineage) and returned as asset ids; images are also attached to the conversation. Cost is estimated before the call and recorded after. Video jobs take minutes: do not wait on them unless asked, use studio_job.',
    parameters: makeParams,
    output: RESULT_OUTPUT,
    async execute(inputArgs, exec): Promise<V2Result> {
      const prompts = Array.isArray(inputArgs.prompts) ? inputArgs.prompts.filter((x): x is string => typeof x === 'string' && x.trim().length > 0) : []
      if (inputArgs.prompts !== undefined && prompts.length === 0) throw new Error('prompts must list at least one non-empty prompt')
      if (prompts.length > 10) throw new Error(`studio_make accepts at most 10 prompts per call (got ${String(prompts.length)}); split larger batches into several calls`)
      if (prompts.length === 0) return runOne(inputArgs, exec)
      // Batch: sequential on purpose (the shared reference images are resolved once; provider concurrency limits stay predictable).
      const results: V2Result[] = []; const failures: string[] = []
      for (const [index, prompt] of prompts.entries()) {
        if (exec.signal.aborted) { failures.push(`#${String(index + 1)} not started: aborted`); continue }
        try { results.push(await runOne({ ...inputArgs, prompt, prompts: undefined, wait: inputArgs.wait ?? true }, exec)) } catch (error) { failures.push(`#${String(index + 1)} "${clip(prompt, 60)}": ${error instanceof Error ? error.message : String(error)}`) }
      }
      const text = [`Batch: ${String(results.length)} of ${String(prompts.length)} succeeded.`, ...results.map((r, i) => `[${String(i + 1)}] ${r.text}`), ...failures.map(f => `Failed ${f}`)].join('\n')
      return { text: clip(text, MAX_TEXT), assetIds: results.flatMap(r => r.assetIds ?? []), attachments: results.flatMap(r => r.attachments ?? []).slice(0, 10), state: failures.length === 0 ? 'succeeded' : results.length === 0 ? 'failed' : 'partial' }
    },
  }))
  async function runOne(inputArgs: Record<string, unknown>, exec: { signal: AbortSignal; agent?: unknown }): Promise<V2Result> {
      let args: Record<string, any> = inputArgs
      const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)
      const list = (v: unknown): string[] | undefined => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : undefined)
      // Outpaint: prepare the expanded canvas + mask first, then continue as an ordinary inpaint on those two assets.
      if (typeof args.expand === 'object' && args.expand !== null && !Array.isArray(args.expand)) {
        const src = str(args.source) === undefined ? undefined : core.db.getAsset(str(args.source)!)
        if (src === undefined || src.kind !== 'image') throw new Error('expand needs source: the asset id of an image')
        const side = (k: string): number | undefined => { const v = (args.expand as Record<string, unknown>)[k]; return typeof v === 'number' && Number.isFinite(v) ? v : undefined }
        const pad = { ...(side('top') === undefined ? {} : { top: side('top')! }), ...(side('right') === undefined ? {} : { right: side('right')! }), ...(side('bottom') === undefined ? {} : { bottom: side('bottom')! }), ...(side('left') === undefined ? {} : { left: side('left')! }) }
        let prepared
        try { prepared = await expandCanvas(new Uint8Array(await core.blobs.read(src.sha256, src.ext)), pad) } catch (error) { throw new Error(error instanceof Error ? error.message : String(error)) }
        const image = await core.assets.ingestBytes(prepared.image, 'image/png', { source: 'derived', title: `${src.title ?? src.id} (expanded)`, tags: ['outpaint'], parents: [{ assetId: src.id, role: 'source' }] })
        const mask = await core.assets.ingestBytes(prepared.mask, 'image/png', { source: 'derived', tags: ['mask'], title: `Mask for ${image.title ?? image.id}`, parents: [{ assetId: image.id, role: 'source' }] })
        args = { ...args, op: 'inpaint', source: image.id, mask: mask.id }
      }
      // Conversation / workspace references (the legacy studio_edit sources): stored as assets so they get lineage and survive the chat.
      {
        const selectors: ReferenceSelectors = {
          ...(str(args.source_attachment_id) === undefined ? {} : { source_attachment_id: str(args.source_attachment_id)! }),
          ...(list(args.source_attachment_ids) === undefined ? {} : { source_attachment_ids: list(args.source_attachment_ids)! }),
          ...(str(args.source_path) === undefined ? {} : { source_path: str(args.source_path)! }),
          ...(list(args.source_paths) === undefined ? {} : { source_paths: list(args.source_paths)! }),
        }
        // Legacy studio_edit behaviour: an edit with no explicit source uses the newest image in the conversation.
        const implicitLatest = Object.keys(selectors).length === 0 && args.op === 'edit' && str(args.source) === undefined && env.resolveReferences !== undefined
        if (Object.keys(selectors).length > 0 || implicitLatest) {
          if (env.resolveReferences === undefined) throw new Error('Conversation and workspace references are not available in this session; pass an asset id from studio_gallery')
          const files = await env.resolveReferences(selectors, exec)
          if (files.length === 0) throw new Error('No reference image could be found: upload or generate an image first, or pass source (an asset id)')
          const stored: string[] = []
          for (const f of files.slice(0, 16)) stored.push((await core.assets.ingestBytes(f.data, f.mediaType, { source: 'import', tags: ['reference'] })).id)
          const [first, ...rest] = stored
          // For editing-style operations the first image is the source; for plain generation they are all references.
          const asSource = args.op !== 'generate'
          args = { ...args, source: asSource ? first : args.source, references: [...(list(args.references) ?? []), ...(asSource ? rest : stored)] }
          if (!asSource && args.source === undefined) delete args.source
        }
      }
      const paramsIn = (typeof args.params === 'object' && args.params !== null && !Array.isArray(args.params) ? args.params : {}) as Record<string, string | number | boolean>
      const body = {
        op: args.op, modelId: str(args.model), prompt: str(args.prompt), negativePrompt: str(args.negative_prompt), tags: list(args.tags), params: paramsIn,
        inputs: { ...(str(args.source) === undefined ? {} : { source: str(args.source) }), ...(list(args.references) === undefined ? {} : { references: list(args.references) }), ...(str(args.mask) === undefined ? {} : { mask: str(args.mask) }), ...(str(args.last_frame) === undefined ? {} : { lastFrame: str(args.last_frame) }),
          ...(args.op === 'animate' && str(args.source) !== undefined ? { firstFrame: str(args.source) } : {}) },
      }
      let request
      try {
        const placeholder = body.modelId ?? 'auto:auto'
        request = parseOperationRequest({ ...body, modelId: placeholder }, 'agent', env.sessionOf(exec))
      } catch (error) { throw new Error(error instanceof HttpError ? `${error.code}: ${error.message}` : String(error)) }
      if (args.model === undefined) {
        const kind: MediaKind = args.op === 'animate' || args.op === 'extend' || args.op === 'restyle' ? 'video' : (str(args.source) !== undefined && (core.db.getAsset(str(args.source)!)?.kind === 'video')) ? 'video' : ('duration' in paramsIn) ? 'video' : 'image'
        const only = str(args.provider) as ProviderId | undefined
        const picked = await core.registry.pickDefault(request, kind, [], { ...(only === undefined ? {} : { only }), ...(env.defaultProvider?.() === undefined ? {} : { prefer: env.defaultProvider()! }) })
        if (picked === undefined) throw new Error(`No configured model can do "${String(args.op)}"${kind === 'video' ? ' for video' : ''}${only === undefined ? '' : ` on provider ${only}`}. Call studio_models with all=true to see what needs a key, then ask the user to add it in Settings > Plugins > Studio.`)
        request = { ...request, modelId: picked.id }
      }
      // A video source for upscale/restyle/extend travels as `video`.
      if (request.inputs.source !== undefined && ['upscale', 'restyle', 'extend'].includes(request.op) && core.db.getAsset(request.inputs.source.assetId)?.kind === 'video') {
        const { source, ...rest } = request.inputs
        request = { ...request, inputs: { ...rest, video: source } }
      }
      let job: JobRecord
      try { job = await core.runner.submit(request) } catch (error) {
        if (error instanceof AdapterError) throw new Error(error.message)
        throw error
      }
      const { model } = await core.registry.resolveModel(job.modelId)
      const kind = mediaKindOf(model.capabilities)
      const wait = args.wait ?? (kind === 'image')
      const head = `Job ${job.id} started on ${model.label}${job.estimateUsd === undefined ? '' : `, estimated ${usd(job.estimateUsd)}`}.`
      if (args.run_in_background === true) {
        const jobs = jobsService()
        const agent = (exec as { agent?: { id: string } }).agent
        if (jobs === undefined || agent === undefined) throw new Error('Background jobs are not available in this session; omit run_in_background and use studio_job to check progress.')
        const agentJobId = jobs.start({
          kind: 'studio', label: `${String(args.op)} ${model.label}: ${clip(request.prompt ?? '', 60)}`, owner: agent.id,
          run: (handle: { append(t: string): void; updateProgress(l: string): void }) => {
            const off = core.runner.onJob(j => { if (j.id === job.id) { handle.updateProgress(j.message ?? j.state); } })
            const done = core.runner.wait(job.id).then(j => { off(); return { status: j.state === 'succeeded' ? 'completed' : j.state === 'canceled' ? 'killed' : 'failed', detail: j.state, result: jobLine(j) } })
            return { cancel: () => { void core.runner.cancel(job.id) }, done }
          },
        })
        return { text: `${head} Registered as background job ${agentJobId}; its result arrives with the completion notice.`, jobId: job.id, state: job.state }
      }
      if (!wait) return { text: `${head} It runs in the background (video typically takes 1-5 minutes). Check it with studio_job {id:"${job.id}"}.`, jobId: job.id, state: job.state }
      const done = await Promise.race([core.runner.wait(job.id), new Promise<JobRecord>((_, reject) => { exec.signal.addEventListener('abort', () => { void core.runner.cancel(job.id); reject(exec.signal.reason) }, { once: true }) })])
      return finish(env, done, head, exec)
  }

  ctx.tools.register(defineTool({
    name: 'studio_job',
    description: 'Check, wait for, cancel or retry a Studio job started by studio_make. Without id, lists recent jobs.',
    parameters: {
      id: { type: 'string', description: 'Job id (job_…). Omit to list recent jobs.' },
      action: { type: 'string', enum: ['status', 'wait', 'cancel', 'retry'], description: 'status (default), wait (up to 60 s), cancel, or retry a failed job (a new paid call).' },
    },
    output: RESULT_OUTPUT,
    async execute(args, _exec): Promise<V2Result> {
      if (args.id === undefined) {
        const jobs = core.db.listJobs({ limit: 12 })
        return { text: jobs.length === 0 ? 'No Studio jobs yet.' : clip(jobs.map(jobLine).join('\n'), MAX_TEXT), assetIds: [], }
      }
      if (!/^job_[0-9A-Za-z]+$/.test(args.id)) throw new Error('Invalid job id')
      let job = core.db.getJob(args.id)
      if (job === undefined) throw new Error(`Unknown job ${args.id}`)
      const action = args.action ?? 'status'
      if (action === 'cancel') job = (await core.runner.cancel(args.id)) ?? job
      else if (action === 'retry') job = await core.runner.retry(args.id)
      else if (action === 'wait' && ACTIVE_JOB_STATES.includes(job.state)) job = await core.runner.wait(args.id, 60_000)
      return finish(env, job, `Job ${job.id}:`)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'studio_gallery',
    description: 'Search the Studio gallery (every image and video Studio ever made or imported). Returns asset ids you can pass to studio_make as source/references/mask. Supports full-text search of prompts, tags, favourites, kind, model and lineage.',
    parameters: {
      query: { type: 'string', description: 'Words to find in prompts, titles, tags and notes.' },
      kind: { type: 'string', enum: ['image', 'video'], description: 'Only this media kind.' },
      favorites: { type: 'boolean', description: 'Only favourites.' },
      tag: { type: 'string', description: 'Only assets with this tag.' },
      model: { type: 'string', description: 'Only assets made with this model id.' },
      derived_from: { type: 'string', description: 'Only assets derived from this asset id.' },
      limit: { type: 'integer', description: 'Maximum results, 1-30 (default 10).' },
      asset: { type: 'string', description: 'Show full detail and lineage of one asset id instead of searching.' },
    },
    output: RESULT_OUTPUT,
    async execute(args, _exec): Promise<V2Result> {
      if (args.asset !== undefined) {
        const a = core.db.getAsset(args.asset); if (a === undefined || a.deletedAt !== undefined) throw new Error(`Unknown asset ${args.asset}`)
        const parents = core.db.parents(a.id).map(e => `${e.role}:${e.parentId}`).join(', ')
        const text = [describeAsset(a), `created ${new Date(a.createdAt).toISOString()}${a.costUsd === undefined ? '' : `, cost ${usd(a.costUsd)}`}${a.seed === undefined ? '' : `, seed ${String(a.seed)}`}`, a.prompt === undefined ? '' : `prompt: ${clip(a.prompt, 600)}`, a.params === undefined ? '' : `params: ${clip(JSON.stringify(a.params), 300)}`, parents === '' ? 'no parents' : `derived from: ${parents}`].filter(Boolean).join('\n')
        return { text, assetIds: [a.id], }
      }
      const found = core.db.queryAssets({ limit: Math.min(30, args.limit ?? 10), ...(args.query === undefined ? {} : { query: args.query }), ...(args.kind === undefined ? {} : { kind: args.kind as MediaKind }), ...(args.favorites === true ? { favorite: true } : {}), ...(args.tag === undefined ? {} : { tag: args.tag }), ...(args.model === undefined ? {} : { modelId: args.model }), ...(args.derived_from === undefined ? {} : { parentOf: args.derived_from }) })
      return { text: found.items.length === 0 ? 'No matching assets.' : clip(`${String(found.total)} match(es):\n${found.items.map(describeAsset).join('\n')}`, MAX_TEXT), assetIds: found.items.map(a => a.id), }
    },
  }))
  void capabilitiesFor; void (0 as unknown as Operation)
}

/** Build the result text and attach produced images to the conversation (videos are referenced by id and path). */
async function finish(env: ToolEnv, job: JobRecord, head: string, exec?: unknown): Promise<V2Result> {
  const assets = job.assetIds.map(id => env.core.db.getAsset(id)).filter((a): a is AssetRecord => a !== undefined)
  const attachments: ImageAttachmentRef[] = []
  const saved = new Map<string, string>(); const saveErrors: string[] = []
  for (const a of assets.slice(0, 4)) {
    if (a.kind === 'image' && env.attachImage !== undefined) {
      const ref = await env.attachImage(a).catch(() => undefined)
      if (ref !== undefined) {
        attachments.push(ref)
        if (env.saveToWorkspace !== undefined && exec !== undefined) {
          const bytes = new Uint8Array(await env.core.blobs.read(a.sha256, a.ext))
          const r: { path?: string; error?: string } = await env.saveToWorkspace(ref, bytes, exec).catch((e: unknown) => ({ error: e instanceof Error ? e.message : String(e) }))
          if (r.path !== undefined) { saved.set(a.id, r.path); env.core.db.updateAsset(a.id, { workspacePath: r.path }) } else if (r.error !== undefined) saveErrors.push(r.error)
        }
      }
    }
  }
  const lines = [head, jobLine(job)]
  for (const a of assets) lines.push(a.kind === 'video' ? `Video saved: ${env.core.assets.pathOf(a)} (open it in Studio; use look_video to inspect)` : `Image ${a.id} saved to the Studio gallery${saved.has(a.id) ? ` and to the workspace at ${JSON.stringify(saved.get(a.id)!)}` : ''}.`)
  for (const e of saveErrors.slice(0, 1)) lines.push(`Saving to the workspace failed: ${e}`)
  if (job.state === 'needs_attention') lines.push('This needs the user: fix the API key or credits in Settings > Plugins > Studio, then retry with studio_job.')
  return { text: clip(lines.join('\n'), MAX_TEXT), jobId: job.id, state: job.state, assetIds: [...job.assetIds], attachments }
}
void ({} as ToolResult)
