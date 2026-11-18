/**
 * Host half of Skill studio.
 *  - hides DSH-disabled skills from every registry consumer (catalog, `skill` tool, `/name`, `/` menu) by wrapping the
 *    live SkillRegistry read methods; files under any skill root are never touched by that mechanism;
 *  - scans every skill root (incl. shadowed and invalid skills the registry drops) for the manager page;
 *  - the only code that writes skill files is ./host/writer.ts, reached only from the save/create/duplicate routes.
 */
import { registerSkillRemote } from './host/push.ts'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { installRegistryFilter, type FilterHandle, type RawRegistry } from './host/registry-filter.ts'
import { detectDshVersion, versionSupported } from './host/version.ts'
import { SettingsStore, applyToggle, isHidden, stateOf, type Settings } from './host/store.ts'
import { computeRoots, findProjectRoot, scanRoots, sha256, type ScanEntry, type ScanRoot } from './host/scanner.ts'
import { createSkill, duplicateSkill, saveSkill, WriteRefusal, type WriterOptions } from './host/writer.ts'
import { validateSkillText } from './host/frontmatter.ts'
import { buildRows, type RegistrySummary } from './host/model.ts'
import { UsageIndex, type SessionReader } from './host/usage.ts'
import { readFile, readdir } from 'node:fs/promises'
import { createEvolution } from './evolution.ts'

export const name = '@t3labs/ohmydsh-skill-studio'
export const inject = ['skills']

export const API = '/api/skill-studio'

interface Peerish { headers: Headers }
type Json = Record<string, unknown>

function ok(value: unknown): Response {
  return Response.json({ ok: true, value }, { headers: { 'cache-control': 'no-store' } })
}
function fail(code: string, message: string, extra?: Json): Response {
  return Response.json({ ok: false, error: { code, message, ...extra } }, { headers: { 'cache-control': 'no-store' } })
}

/** Mutations must come from the page itself: an Origin header, when present, has to name this host. */
export function sameOrigin(headers: Headers): boolean {
  const origin = headers.get('origin')
  if (origin === null) return true
  const host = headers.get('host')
  try { return host !== null && new URL(origin).host === host } catch { return false }
}

export function apply(ctx: Context): void {
  const log = { info: (m: string) => { ctx.logger.info(m) }, warn: (m: string) => { ctx.logger.warn(m) } }
  const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  const agentsHome = homedir()
  const dataDir = join(dshHome, 'skill-studio')
  const store = new SettingsStore(dataDir)
  const writerOptions: WriterOptions = { backupsDir: join(dataDir, 'backups') }
  const usage = new UsageIndex()
  const rootCache = new Map<string, { at: number; root: string }>()

  const projectRootOf = async (cwd: string | undefined): Promise<string | undefined> => {
    if (cwd === undefined) return undefined
    const hit = rootCache.get(cwd)
    if (hit !== undefined && Date.now() - hit.at < 60_000) return hit.root
    const root = await findProjectRoot(cwd)
    rootCache.set(cwd, { at: Date.now(), root })
    return root
  }

  let handle: FilterHandle | undefined
  void store.load().then(() => {
    // Never let a late failure (e.g. the context was disposed because another part of apply failed) become a fatal unhandled rejection.
    try {
    // Version gate: only patch the registry on the release line this plugin was built and tested for.
    const version = detectDshVersion()
    if (version !== undefined && !versionSupported(version)) {
      log.warn(`skill-studio: DSH ${version} is outside the supported range; not filtering skills (fail open). The manager page is read-only for disable.`)
      handle = { installed: false, reason: `DSH ${version} is outside the supported range`, lastScope: () => undefined, dispose: () => {} }
      return
    }
    const skills = (ctx as unknown as { skills: unknown }).skills
    const live = skills as Record<symbol, unknown>
    const reg = live[Symbol.for('cordis.original')] ?? skills
    handle = installRegistryFilter(reg, {
      logger: log,
      isDisabled: async (skillName, cwd) => isHidden(stateOf(store.settings, skillName, await projectRootOf(cwd))),
    })
    if (handle.installed) ctx.effect(() => () => { handle?.dispose() }, 'skill-studio: restore skill registry')
    } catch (error) { log.warn(`skill-studio: registry filter not installed: ${error instanceof Error ? error.message : String(error)}`) }
  }).catch((error: unknown) => { log.warn(`skill-studio: settings load failed: ${String(error)}`) })

  const agentScope = (): { scope: object | undefined; cwd: string | undefined } => {
    const agents = (ctx as unknown as { get(n: string): { list?(): { ctx?: unknown }[] } | undefined }).get('agents')
    const first = agents?.list?.()[0]
    return { scope: first as object | undefined ?? handle?.lastScope(), cwd: undefined }
  }

  const rawRegistry = (): RawRegistry | undefined => handle?.raw

  async function workspaces(): Promise<{ id: string; title: string; path: string; root: string }[]> {
    const reg = (ctx as unknown as { get(n: string): { list(): { id: string; title: string; path: string }[] } | undefined }).get('workspaceRegistry')
    const list = reg?.list() ?? []
    const out: { id: string; title: string; path: string; root: string }[] = []
    for (const w of list) out.push({ id: String(w.id), title: w.title, path: w.path, root: (await projectRootOf(w.path)) ?? w.path })
    return out
  }

  async function snapshot(input: { workspace?: string }): Promise<{ roots: ScanRoot[]; scan: ScanEntry[]; winners: RegistrySummary[] | undefined; projectRoot: string | undefined; cwd: string | undefined }> {
    const cwd = input.workspace
    const projectRoot = await projectRootOf(cwd)
    const { scope } = agentScope()
    let winners: RegistrySummary[] | undefined
    const raw = rawRegistry()
    if (raw !== undefined) {
      try { winners = (await raw.list({ ...(cwd === undefined ? {} : { cwd }), ...(scope === undefined ? {} : { scope }) })) as unknown as RegistrySummary[] } catch (error) { log.warn(`skill-studio: registry list failed: ${String(error)}`) }
    }
    const customDirs = [...new Set((winners ?? []).filter(w => w.source === 'custom' && w.path !== undefined).map(w => dirname(dirname(w.path!))))]
    const roots = await computeRoots({ ...(cwd === undefined ? {} : { cwd }), dshHome, agentsHome, customDirs })
    const scan = await scanRoots(roots)
    return { roots, scan, winners, projectRoot, cwd }
  }

  const allowedCreateRoots = async (cwd: string | undefined): Promise<Record<string, string>> => {
    const project = await projectRootOf(cwd)
    return {
      'user-agents': join(agentsHome, '.agents/skills'),
      'user-dsh': join(dshHome, 'skills'),
      ...(project === undefined ? {} : { 'project-agents': join(project, '.agents/skills'), 'project-dsh': join(project, '.dsh/skills') }),
    }
  }

  const reader = (): SessionReader | undefined => (ctx as unknown as { get(n: string): SessionReader | undefined }).get('sessionQuery')

  async function handleRoute(method: string, body: Json): Promise<Response> {
    const str = (k: string): string | undefined => (typeof body[k] === 'string' && (body[k] as string).length > 0 ? (body[k] as string) : undefined)
    switch (method) {
      case 'state': {
        const workspace = str('workspace')
        const snap = await snapshot(workspace === undefined ? {} : { workspace })
        const u = usage.peek() ?? { stats: {}, sessionsScanned: 0 }
        const rows = buildRows({ scan: snap.scan, winners: snap.winners, settings: store.settings, projectRoot: snap.projectRoot, usage: u.stats })
        const ws = await workspaces()
        return ok({
          rows, workspaces: ws, projectRoot: snap.projectRoot ?? null,
          roots: snap.roots.map(r => ({ path: r.path, source: r.source })),
          filter: { installed: handle?.installed === true, ...(handle?.reason === undefined ? {} : { reason: handle.reason }) },
          settings: store.settings, usage: { cached: usage.peek() !== undefined, sessionsScanned: u.sessionsScanned },
          registry: snap.winners !== undefined, dshHome, agentsHome,
          createRoots: await allowedCreateRoots(workspace),
        })
      }
      case 'usage': {
        const u = await usage.get(reader(), body.force === true)
        return ok({ stats: u.stats, available: u.available, sessionsScanned: u.sessionsScanned })
      }
      case 'toggle': {
        const skillName = str('name')
        if (skillName === undefined || typeof body.hide !== 'boolean') return fail('bad-request', 'name and hide are required')
        const scopeName = str('scope') ?? 'global'
        const workspace = str('workspace')
        let scope: 'global' | { workspace: string } = 'global'
        if (scopeName === 'workspace') {
          const root = await projectRootOf(workspace)
          if (root === undefined) return fail('bad-request', 'workspace is required for a workspace override')
          scope = { workspace: root }
        }
        const hide = body.hide
        const settings = await store.update(draft => { applyToggle(draft, skillName, hide, scope) })
        try { (ctx as unknown as { emit(n: string): void }).emit('skills/change') } catch { /* notification only */ }
        return ok({ settings, disabled: stateOf(settings, skillName, typeof scope === 'string' ? undefined : scope.workspace) })
      }
      case 'validate': {
        const text = typeof body.text === 'string' ? body.text : ''
        const v = validateSkillText(text, str('dirName'))
        return ok({ wouldLoad: v.wouldLoad, issues: v.issues, name: v.name ?? null, description: v.description ?? null, modelInvocable: v.modelInvocable, userInvocable: v.userInvocable })
      }
      case 'read': {
        const id = str('id')
        const snap = await snapshot(str('workspace') === undefined ? {} : { workspace: str('workspace')! })
        const entry = snap.scan.find(e => e.id === id)
        if (entry === undefined) return fail('not-found', 'That skill is not in any scanned skill root.')
        if (!entry.contentReadable) {
          // SS-1: a symlink out of a project root must not turn the page into a file reader.
          return ok({ id: entry.id, path: entry.path, realPath: entry.realPath, text: '', sha256: '', editable: false, readOnlyReason: 'outside-root', issues: [], wouldLoad: false })
        }
        const text = await readFile(entry.realPath, 'utf8')
        const v = validateSkillText(text, entry.dirName)
        return ok({ id: entry.id, path: entry.path, realPath: entry.realPath, text, sha256: sha256(text), editable: entry.writable, readOnlyReason: entry.readOnlyReason ?? null, issues: v.issues, wouldLoad: v.wouldLoad })
      }
      case 'save': {
        const id = str('id'); const text = body.text; const base = str('baseSha256')
        if (id === undefined || typeof text !== 'string' || base === undefined) return fail('bad-request', 'id, text and baseSha256 are required')
        const snap = await snapshot(str('workspace') === undefined ? {} : { workspace: str('workspace')! })
        const entry = snap.scan.find(e => e.id === id)
        if (entry === undefined) return fail('not-found', 'That skill is not in any scanned skill root.')
        return ok(await saveSkill(writerOptions, entry, text, base))
      }
      case 'create': {
        const nameValue = str('name'); const description = str('description'); const target = str('target') ?? 'user-agents'
        if (nameValue === undefined || description === undefined) return fail('bad-request', 'name and description are required')
        const roots = await allowedCreateRoots(str('workspace'))
        const root = roots[target]
        if (root === undefined) return fail('bad-request', 'Unknown or unavailable target location.')
        const created = await createSkill({ name: nameValue, description, ...(str('body') === undefined ? {} : { body: str('body')! }), root }, Object.values(roots))
        return ok({ ...created, root })
      }
      case 'duplicate': {
        const id = str('id'); const nameValue = str('name'); const target = str('target') ?? 'user-dsh'
        if (id === undefined || nameValue === undefined) return fail('bad-request', 'id and name are required')
        const snap = await snapshot(str('workspace') === undefined ? {} : { workspace: str('workspace')! })
        const entry = snap.scan.find(e => e.id === id)
        if (entry === undefined) return fail('not-found', 'That skill is not in any scanned skill root.')
        const roots = await allowedCreateRoots(str('workspace'))
        const root = roots[target]
        if (root === undefined) return fail('bad-request', 'Unknown or unavailable target location.')
        return ok(await duplicateSkill(entry, nameValue, root, Object.values(roots)))
      }
      case 'backups': {
        const skillName = str('name')
        if (skillName === undefined) return fail('bad-request', 'name is required')
        const dir = join(writerOptions.backupsDir, skillName.replace(/[^a-z0-9._-]/gi, '_'))
        let files: string[] = []
        try { files = (await readdir(dir)).filter(f => f.endsWith('.md')).sort().reverse() } catch { /* none yet */ }
        return ok({ dir, files })
      }
      default:
        return fail('not-found', `Unknown method "${method}".`)
    }
  }

  const isDev = dshHome !== join(homedir(), '.dsh')
  const evolution = createEvolution({
    ctx, dataDir, writer: writerOptions, log, isDev,
    existingSkills: async (cwd) => {
      const snap = await snapshot(cwd === undefined ? {} : { workspace: cwd })
      const rows = buildRows({ scan: snap.scan, winners: snap.winners, settings: store.settings, projectRoot: snap.projectRoot, usage: {} })
      return rows.filter(r => r.state === 'active').map(r => ({ name: r.name, description: r.description, ...(r.path === undefined ? {} : { path: r.path }), id: r.id, editable: r.editable }))
    },
    entryById: async (id, cwd) => (await snapshot(cwd === undefined ? {} : { workspace: cwd })).scan.find(e => e.id === id),
    createRoots: (cwd) => allowedCreateRoots(cwd),
    sessionQuery: () => (ctx as unknown as { get(n: string): never }).get('sessionQuery'),
    usageInvalidate: () => { usage.invalidate() },
  })
  try { evolution.start() } catch (error) { log.warn(`skill-studio: evolution features failed to start: ${error instanceof Error ? error.stack ?? error.message : String(error)}`) }

  // Push channel for the sidebar badge and turn cards: a Typert stream on DSH's multiplexed Remote WebSocket (no HTTP stream,
  // no polling). Same admission as every Remote call: the gateway admits the peer at the WebSocket upgrade.
  ctx.effect(() => registerSkillRemote(ctx as never, evolution), 'skill-studio: remote stream')

  ctx.inject(['connection'], (c: Context) => {
    const connection = (c as unknown as { connection: { fetch: { register(r: unknown): () => Promise<void> }; requestRejection(r: Peerish): number | undefined } }).connection
    for (const method of ['state', 'usage', 'toggle', 'validate', 'read', 'save', 'create', 'duplicate', 'backups', ...evolution.methods]) {
      c.effect(() => connection.fetch.register({
        path: `${API}/${method}`,
        methods: ['POST'],
        requestBody: 'buffered',
        fetch: async (request: Request) => {
          // Fail closed: the shared channel already admitted the peer; re-check here and require same-origin for every call.
          let rejection: number | undefined
          try { rejection = connection.requestRejection(request) } catch { rejection = 503 }
          if (rejection !== undefined) return new Response(JSON.stringify({ error: rejection === 401 ? 'unauthorized' : 'forbidden' }), { status: rejection === 401 ? 401 : rejection, headers: { 'content-type': 'application/json' } })
          if (!sameOrigin(request.headers)) return new Response(JSON.stringify({ error: 'origin-rejected' }), { status: 403, headers: { 'content-type': 'application/json' } })
          let body: Json = {}
          try { const parsed = await request.json() as unknown; if (typeof parsed === 'object' && parsed !== null) body = parsed as Json } catch { return fail('bad-request', 'Body is not JSON') }
          try {
            return (await evolution.route(method, body)) ?? await handleRoute(method, body)
          } catch (error) {
            if (error instanceof WriteRefusal) return fail(error.code, error.message, error.issues === undefined ? undefined : { issues: error.issues })
            log.warn(`skill-studio: ${method} failed: ${error instanceof Error ? error.message : String(error)}`)
            return fail('internal', 'Something went wrong; see the host log.')
          }
        },
      }), `skill-studio: ${method} route`)
    }
  })
}

export type { Settings }
