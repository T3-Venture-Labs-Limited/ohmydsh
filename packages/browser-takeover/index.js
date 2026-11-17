/**
 * dsh-agent-browser-takeover — host half.
 *
 * Companion to dsh-agent-browser; it does not modify that package. It adds
 * what a Manus-style "watch and take over" flow needs:
 *
 *  1. A control lease per browser session (agent | human). While the human
 *     holds a session, every browser_* tool call for it is refused through
 *     tools.guard(), so the agent cannot fight the user's mouse and keyboard.
 *  2. browser_request_human: the agent hands the browser to the user (sign in,
 *     MFA, captcha, payment) and waits until the user hands it back from the
 *     sidebar, or until the timeout.
 *  3. /abx/state and /abx/control routes for the sidebar tab. Input
 *     forwarding itself stays in dsh-agent-browser's /browser/stream proxy;
 *     this plugin switches its /browser/takeover flag in step with the lease
 *     and adopts a takeover started from dsh-agent-browser's own chip.
 *  4. One browser per conversation: a tools/execute wrapper gives every
 *     browser_* call without an explicit `session` the conversation's own
 *     session name, so parallel conversations never share (or fight over) a
 *     browser. Subagents get their own, too.
 *  5. Shared logins: each browser's profile is seeded from logins.json by
 *     bin/agent-browser.mjs (the binaryPath wrapper). Handing a browser back
 *     after taking control, or calling browser_save_logins, merges that
 *     browser's cookies and storage into logins.json for every later browser.
 *
 * No third-party imports: a linked local bundle resolves nothing beyond Node.
 *
 * @module dsh-agent-browser-takeover
 */

import { spawn } from 'node:child_process'
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

export const name = 'dsh-agent-browser-takeover'
export const inject = ['tools', 'systemPrompt']

const DEFAULT_KEY = '__default__'
const BROWSER_TOOLS = new Set([
  'browser_open', 'browser_snapshot', 'browser_find', 'browser_act', 'browser_get',
  'browser_eval', 'browser_screenshot', 'browser_tabs',
])
/** Tools whose omitted `session` means "this conversation's browser". */
const ROUTED_TOOLS = new Set([...BROWSER_TOOLS, 'browser_session', 'browser_request_human', 'browser_save_logins'])

const ROOT = process.env.ABX_ROOT ?? path.join(os.homedir(), '.agent-browser', 'dsh')
const SEED_FILE = path.join(ROOT, 'logins.json')
const SESSIONS_DIR = path.join(ROOT, 'sessions')

function readConfig(raw) {
  const cfg = raw ?? {}
  return {
    humanIdleMinutes: Number.isFinite(cfg.humanIdleMinutes) ? Math.max(0, cfg.humanIdleMinutes) : 10,
    requestTimeoutMinutes: Number.isFinite(cfg.requestTimeoutMinutes) ? Math.max(1, cfg.requestTimeoutMinutes) : 15,
    perConversation: cfg.perConversation !== false,
    saveLoginsOnHandback: cfg.saveLoginsOnHandback !== false,
    pruneAfterDays: Number.isFinite(cfg.pruneAfterDays) ? Math.max(0, cfg.pruneAfterDays) : 14,
    binaryPath: typeof cfg.binaryPath === 'string' ? cfg.binaryPath : undefined,
  }
}

/** A stable, agent-browser-safe session name for one conversation (letters, digits, -, _). */
function conversationSession(agentId) {
  const id = String(agentId ?? '').replace(/^session-/, '').replace(/[^A-Za-z0-9_-]/g, '')
  return id.length > 0 ? `c-${id.slice(0, 12)}` : undefined
}

/**
 * Merge one browser's saved state into the shared store: cookies keyed by
 * (domain, path, name) and origins keyed by origin; the newer browser wins.
 */
function mergeState(base, add) {
  const cookieKey = (c) => `${c.domain}\u0000${c.path}\u0000${c.name}`
  const cookies = new Map((base.cookies ?? []).map((c) => [cookieKey(c), c]))
  for (const c of add.cookies ?? []) {
    // Session cookies die with their browser; never hand them to other browsers.
    if (c.session === true || c.expires === -1) continue
    cookies.set(cookieKey(c), c)
  }
  const origins = new Map((base.origins ?? []).map((o) => [o.origin, o]))
  for (const o of add.origins ?? []) {
    if ((o.localStorage ?? []).length === 0) continue
    origins.set(o.origin, { origin: o.origin, localStorage: o.localStorage, sessionStorage: [] })
  }
  const now = Date.now() / 1000
  return {
    cookies: [...cookies.values()].filter((c) => !(typeof c.expires === 'number' && c.expires > 0 && c.expires < now)),
    origins: [...origins.values()],
  }
}

/** Run the wrapper (and so agent-browser) once; resolves to the parsed JSON envelope. */
function runAgentBrowser(binaryPath, argv, timeoutMs = 60_000) {
  return new Promise((resolve) => {
    const isScript = /\.[cm]?js$/.test(binaryPath)
    const child = spawn(isScript ? process.execPath : binaryPath, isScript ? [binaryPath, ...argv] : argv, {
      stdio: ['ignore', 'pipe', 'ignore'],
      env: Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^DSH_/.test(k))),
    })
    let out = ''
    const timer = setTimeout(() => { try { child.kill('SIGKILL') } catch { /* gone */ } }, timeoutMs)
    child.stdout.on('data', (d) => { out += d })
    child.on('close', () => {
      clearTimeout(timer)
      try { resolve(JSON.parse(out.trim())) } catch { resolve({ success: false, error: out.trim().slice(-300) || 'no output' }) }
    })
    child.on('error', (error) => { clearTimeout(timer); resolve({ success: false, error: error.message }) })
  })
}

const keyOf = (session) => (typeof session === 'string' && session.length > 0 ? session : DEFAULT_KEY)
const sessionOf = (key) => (key === DEFAULT_KEY ? undefined : key)

function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

function sameOrigin(req) {
  const origin = req.headers.origin
  if (!origin) return true
  try { return new URL(origin).host === req.headers.host } catch { return false }
}

async function readBody(req) {
  let body = ''
  for await (const chunk of req) {
    body += String(chunk)
    if (body.length > 64 * 1024) throw new Error('body too large')
  }
  return body ? JSON.parse(body) : {}
}

export function apply(ctx, rawConfig) {
  const config = readConfig(rawConfig)
  /** key -> { owner, since, request } */
  const leases = new Map()
  let origin = null

  // ── Shared logins ───────────────────────────────────────────────────────
  let saving = Promise.resolve()
  /**
   * Save one browser's cookies and local storage into logins.json so every
   * browser started afterwards is signed in too. Serialized: concurrent
   * hand-backs merge one after another instead of overwriting each other.
   */
  function saveLogins(key) {
    const run = async () => {
      if (!config.binaryPath) return { ok: false, error: 'binaryPath not configured' }
      await mkdir(ROOT, { recursive: true, mode: 0o700 })
      const tmp = path.join(ROOT, `.save-${process.pid}-${Date.now()}.json`)
      const argv = [...(sessionOf(key) ? ['--session', sessionOf(key)] : []), '--json', 'state', 'save', tmp]
      const saved = await runAgentBrowser(config.binaryPath, argv)
      if (!saved?.success) return { ok: false, error: saved?.error ?? 'state save failed' }
      try {
        const add = JSON.parse(await readFile(tmp, 'utf8'))
        let base = { cookies: [], origins: [] }
        try { base = JSON.parse(await readFile(SEED_FILE, 'utf8')) } catch { /* first save */ }
        const merged = mergeState(base, add)
        const next = `${SEED_FILE}.tmp`
        await writeFile(next, JSON.stringify(merged), { mode: 0o600 })
        await rename(next, SEED_FILE)
        // This browser already holds what it just contributed.
        if (sessionOf(key)) {
          const marker = path.join(SESSIONS_DIR, sessionOf(key), '.seeded')
          await writeFile(marker, '', { mode: 0o600 }).catch(() => {})
        }
        return { ok: true, cookies: merged.cookies.length, sites: merged.origins.length }
      } finally {
        await rm(tmp, { force: true })
      }
    }
    const result = saving.then(run, run)
    saving = result.catch(() => {})
    return result
  }

  // ── One browser per conversation ────────────────────────────────────────
  // Rewrite an omitted `session` before the tool body runs. Guards and
  // pre-execute policy already saw the original arguments, so the takeover
  // guard below resolves the same name itself.
  const routedKey = (exec) => {
    const args = exec.arguments !== null && typeof exec.arguments === 'object' ? exec.arguments : {}
    if (typeof args.session === 'string' && args.session.length > 0) return args.session
    return config.perConversation ? (conversationSession(exec.agent?.id) ?? DEFAULT_KEY) : DEFAULT_KEY
  }
  if (config.perConversation) {
    ctx.on('tools/execute', (exec, next) => {
      if (!ROUTED_TOOLS.has(exec.name)) return next()
      const args = exec.arguments !== null && typeof exec.arguments === 'object' ? exec.arguments : {}
      if (typeof args.session === 'string' && args.session.length > 0) return next()
      const session = conversationSession(exec.agent?.id)
      if (session === undefined) return next()
      exec.arguments = { ...args, session }
      return next()
    })
  }

  // Remove profiles of conversations idle longer than pruneAfterDays.
  ctx.effect(() => {
    const prune = async () => {
      if (config.pruneAfterDays <= 0) return
      let names = []
      try { names = await readdir(SESSIONS_DIR) } catch { return }
      const cutoff = Date.now() - config.pruneAfterDays * 86_400_000
      for (const name of names) {
        if (!/^c-[A-Za-z0-9_-]+$/.test(name)) continue
        const dir = path.join(SESSIONS_DIR, name)
        try {
          const used = (await stat(path.join(dir, '.last-used'))).mtimeMs
          if (used < cutoff && !leases.has(name)) await rm(dir, { recursive: true, force: true })
        } catch { /* in use or already gone */ }
      }
    }
    void prune()
    const timer = setInterval(() => { void prune() }, 6 * 60 * 60 * 1000)
    return () => clearInterval(timer)
  }, 'abx: prune old browser profiles')

  const leaseOf = (key) => {
    let lease = leases.get(key)
    if (!lease) {
      lease = { owner: 'agent', since: Date.now(), request: null }
      leases.set(key, lease)
    }
    return lease
  }

  /** Flip dsh-agent-browser's input-forwarding flag through its own route. */
  async function setForwarding(key, enabled) {
    if (!origin) return { ok: false, error: 'web server not ready' }
    try {
      const res = await fetch(`${origin}/browser/takeover`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ session: sessionOf(key) ?? null, enabled }),
      })
      const body = await res.json().catch(() => ({}))
      return res.ok ? { ok: true } : { ok: false, error: body.error ?? `HTTP ${res.status}` }
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error) }
    }
  }

  async function take(key) {
    const forwarding = await setForwarding(key, true)
    const lease = leaseOf(key)
    lease.owner = 'human'
    lease.since = Date.now()
    touch()
    arm()
    return forwarding
  }

  async function release(key, reason, note) {
    const lease = leaseOf(key)
    const wasHuman = lease.owner === 'human'
    const request = lease.request
    lease.owner = 'agent'
    lease.since = Date.now()
    lease.request = null
    touch()
    await setForwarding(key, false)
    // A deliberate hand-back is when sign-ins happen: share them before the
    // agent resumes, so its next browsers (and other conversations) have them.
    let saved
    if (wasHuman && reason === 'handback' && config.saveLoginsOnHandback) {
      saved = await saveLogins(key).catch((error) => ({ ok: false, error: String(error?.message ?? error) }))
    }
    request?.resolve({ reason, note, saved })
    touch()
  }

  const isHuman = (key) => leases.get(key)?.owner === 'human'

  const snapshot = () => [...leases.entries()].map(([key, lease]) => ({
    session: sessionOf(key) ?? null,
    owner: lease.owner,
    since: lease.since,
    request: lease.request
      ? {
          reason: lease.request.reason,
          url: lease.request.url ?? null,
          at: lease.request.at,
          deadline: lease.request.deadline,
          agentSessionId: lease.request.agentSessionId ?? null,
        }
      : null,
  }))

  // ── Push channel for the sidebar tab ────────────────────────────────────
  // The tab used to poll /abx/state and /browser/sessions every 1.5-5 s forever. Now it opens one
  // server-sent-events stream; the host writes a frame only when the lease table or the browser
  // session list actually changed, so an idle page makes no requests at all.
  /** @type {Set<import('node:http').ServerResponse>} */
  const subscribers = new Set()
  /** Browser session names from the last reconcile, or null until it has run. */
  let sessionNames = null
  let lastPayload = ''
  const statePayload = () => JSON.stringify({ leases: snapshot(), humanIdleMinutes: config.humanIdleMinutes, sessions: sessionNames })
  /** Send the current state to every subscriber if (and only if) it differs from the last frame. */
  function touch() {
    if (subscribers.size === 0) { lastPayload = ''; return }
    const payload = statePayload()
    if (payload === lastPayload) return
    lastPayload = payload
    for (const res of subscribers) {
      try { res.write(`event: state\ndata: ${payload}\n\n`) } catch { subscribers.delete(res) }
    }
  }

  // ── Tool lock while the human drives ────────────────────────────────────
  ctx.effect(() => ctx.tools.guard((exec) => {
    if (!BROWSER_TOOLS.has(exec.name)) return undefined
    if (!isHuman(keyOf(routedKey(exec)))) return undefined
    return {
      reason: 'The user is controlling this browser right now (human takeover). Do not retry browser tools in a loop: '
        + 'call browser_request_human to wait for the hand-back, or continue with other work.',
      info: { name: 'BrowserHumanControl', code: 'HUMAN_IN_CONTROL' },
    }
  }), 'abx: browser tool guard')

  ctx.effect(() => ctx.systemPrompt.section({
    name: 'tool:browser-takeover',
    order: 113,
    text: [
      'The user watches the browser live in the right sidebar ("Agent browser" tab) and can take control of it.',
      'When a step needs the human — signing in, MFA, captchas, payments or other consent, or anything involving their secrets — open the page, then call browser_request_human with a clear reason instead of asking for credentials in chat; it waits until they hand control back.',
      'While the user holds control, browser_* tools are refused with HUMAN_IN_CONTROL.',
      'Each conversation has its own browser, so parallel conversations never collide; omit `session` to use it.',
      'Every new browser starts with the user\'s saved logins and logins are saved again after each hand-back, so check whether you are already signed in before asking for help.',
      'After you sign in to something yourself (without the user), call browser_save_logins so later browsers stay signed in.',
    ].join(' '),
  }), 'abx: prompt section')

  // ── browser_request_human ───────────────────────────────────────────────
  ctx.effect(() => ctx.tools.register({
    name: 'browser_request_human',
    description: 'Hand the live browser to the user and wait until they hand it back. Use for sign-in, MFA, captchas, cookie/consent walls, payments, or any step that needs the human or their secrets. Navigate to the right page with browser_open first. The user sees your reason in the sidebar "Agent browser" tab. Returns when they click "Hand back" (or on timeout); take a fresh snapshot afterwards.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        reason: { type: 'string', description: 'What you need the user to do, e.g. "Sign in to GitHub, then hand back".' },
        timeoutMinutes: { type: 'number', description: 'Maximum wait in minutes (1-240). Defaults to the configured request timeout.' },
        session: { type: 'string', description: 'Named browser session; omit for the conversation default.' },
      },
      required: ['reason'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          outcome: { type: 'string' },
          note: { type: 'string' },
          waitedSeconds: { type: 'number' },
          loginsSaved: { type: 'boolean' },
        },
        required: ['outcome', 'waitedSeconds'],
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.outcome === 'handback'
          ? `The user handed the browser back after ${value.waitedSeconds}s.${value.note ? ` Their note: ${value.note}` : ''}${value.loginsSaved ? ' Their logins were saved for future browsers.' : ''} Take a fresh snapshot before continuing.`
          : value.outcome === 'timeout'
            ? `No hand-back within the timeout (${value.waitedSeconds}s). The browser is back under agent control; check the page and, if needed, ask the user in chat.`
            : value.outcome === 'unavailable'
              ? `Takeover is unavailable (${value.note ?? 'unknown reason'}). Ask the user in chat instead.`
              : `The request ended (${value.outcome}) after ${value.waitedSeconds}s. Take a fresh snapshot before continuing.`,
      }],
    },
    timeoutMs: 4 * 60 * 60 * 1000 + 60_000,
    isConcurrencySafe: () => false,
    presentCall: (args) => ({
      card: 'generic',
      kind: 'other',
      title: `Waiting for you in the browser: ${String(args?.reason ?? '')}`.slice(0, 160),
    }),
    async execute(rawArgs, exec) {
      const args = rawArgs !== null && typeof rawArgs === 'object' ? rawArgs : {}
      if (typeof args.reason !== 'string' || args.reason.trim() === '') throw new Error('reason is required')
      const key = keyOf(args.session)
      const minutes = Number.isFinite(args.timeoutMinutes)
        ? Math.min(Math.max(args.timeoutMinutes, 1), 240)
        : config.requestTimeoutMinutes
      const started = Date.now()
      const lease = leaseOf(key)
      lease.request?.resolve({ reason: 'superseded' })
      const forwarding = await take(key)
      if (!forwarding.ok) {
        await release(key, 'unavailable')
        return { outcome: 'unavailable', note: `input forwarding refused: ${forwarding.error}`, waitedSeconds: 0 }
      }
      const outcome = await new Promise((resolve) => {
        const timer = setTimeout(() => { void release(key, 'timeout') }, minutes * 60_000)
        const onAbort = () => { void release(key, 'cancelled') }
        exec.signal?.addEventListener('abort', onAbort, { once: true })
        leaseOf(key).request = {
          reason: args.reason.trim().slice(0, 500),
          at: started,
          deadline: started + minutes * 60_000,
          agentSessionId: exec.agent?.id ?? null,
          resolve: (value) => {
            clearTimeout(timer)
            exec.signal?.removeEventListener('abort', onAbort)
            resolve(value)
          },
        }
        touch()
      })
      return {
        outcome: outcome.reason,
        ...(outcome.note ? { note: String(outcome.note).slice(0, 1000) } : {}),
        waitedSeconds: Math.round((Date.now() - started) / 1000),
        ...(outcome.saved ? { loginsSaved: outcome.saved.ok === true } : {}),
      }
    },
  }), 'abx: browser_request_human')

  // ── browser_save_logins ─────────────────────────────────────────────────
  ctx.effect(() => ctx.tools.register({
    name: 'browser_save_logins',
    description: 'Save this browser\'s cookies and local storage to the shared login store, so every browser started later (in this or any other conversation) is already signed in. Call it after signing in to a site yourself. Hand-backs from the user save automatically.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        session: { type: 'string', description: 'Named browser session; omit for this conversation\'s browser.' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          cookies: { type: 'number' },
          sites: { type: 'number' },
          error: { type: 'string' },
        },
        required: ['ok'],
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.ok
          ? `Logins saved. The shared store now holds ${value.cookies} cookies and storage for ${value.sites} sites.`
          : `Could not save logins: ${value.error ?? 'unknown error'}.`,
      }],
    },
    timeoutMs: 90_000,
    isConcurrencySafe: () => false,
    presentCall: () => ({ card: 'generic', kind: 'other', title: 'Save browser logins' }),
    async execute(rawArgs) {
      const args = rawArgs !== null && typeof rawArgs === 'object' ? rawArgs : {}
      const result = await saveLogins(keyOf(args.session))
      return result.ok
        ? { ok: true, cookies: result.cookies, sites: result.sites }
        : { ok: false, error: String(result.error).slice(0, 500) }
    },
  }), 'abx: browser_save_logins')

  // ── Routes for the sidebar tab ──────────────────────────────────────────
  // Plugin routes bypass DSH's login cookie unless they check it themselves,
  // so both routes apply Connection's own Host/Origin + browser-auth check.
  ctx.inject(['webServer', 'connection'], (scoped) => {
    const webServer = scoped.webServer
    const connection = scoped.connection
    const rejected = (req, res) => {
      const status = connection.requestRejection({ headers: req.headers })
      if (status === undefined) return false
      sendJson(res, status, { ok: false, error: 'dsh web authentication required' })
      return true
    }
    scoped.effect(() => {
      try { origin = webServer.getOrigin() } catch { origin = null }
      const disposeState = webServer.register({
        kind: 'exact',
        path: '/abx/state',
        handler: async (req, res) => {
          if (rejected(req, res)) return
          if (req.method !== 'GET') { res.writeHead(405).end(); return }
          sendJson(res, 200, { leases: snapshot(), humanIdleMinutes: config.humanIdleMinutes, sessions: sessionNames })
        },
      })
      const disposeEvents = webServer.register({
        kind: 'exact',
        path: '/abx/events',
        handler: async (req, res) => {
          if (rejected(req, res)) return
          if (req.method !== 'GET') { res.writeHead(405).end(); return }
          res.writeHead(200, {
            'content-type': 'text/event-stream; charset=utf-8',
            'cache-control': 'no-store',
            connection: 'keep-alive',
            'x-accel-buffering': 'no',
          })
          // First frame is always the full state, so a (re)connecting client never needs a separate GET.
          res.write(`retry: 3000\nevent: state\ndata: ${statePayload()}\n\n`)
          subscribers.add(res)
          wake()
          const heartbeat = setInterval(() => { try { res.write(': ping\n\n') } catch { /* closed */ } }, 25_000)
          heartbeat.unref?.()
          res.on('close', () => { clearInterval(heartbeat); subscribers.delete(res) })
        },
      })
      const disposeControl = webServer.register({
        kind: 'exact',
        path: '/abx/control',
        handler: async (req, res) => {
          if (rejected(req, res)) return
          if (req.method !== 'POST') { res.writeHead(405).end(); return }
          if (!sameOrigin(req)) { sendJson(res, 403, { ok: false, error: 'cross-site request rejected' }); return }
          let body
          try { body = await readBody(req) } catch { sendJson(res, 400, { ok: false, error: 'invalid body' }); return }
          const key = keyOf(body.session)
          if (body.action === 'take') {
            const forwarding = await take(key)
            if (!forwarding.ok) {
              await release(key, 'unavailable')
              sendJson(res, 409, { ok: false, error: `dsh-agent-browser refused takeover: ${forwarding.error}`, leases: snapshot() })
              return
            }
          } else if (body.action === 'release') {
            await release(key, 'handback', typeof body.note === 'string' && body.note.trim() ? body.note.trim() : undefined)
          } else {
            sendJson(res, 400, { ok: false, error: 'action must be take or release' })
            return
          }
          sendJson(res, 200, { ok: true, leases: snapshot() })
        },
      })
      return () => {
        disposeState(); disposeEvents(); disposeControl(); origin = null
        for (const res of subscribers) { try { res.end() } catch { /* closed */ } }
        subscribers.clear()
      }
    }, 'abx: sidebar routes')
  })

  // ── Reconcile with dsh-agent-browser and expire idle human control ──────
  // Previously a fixed 2 s setInterval that fetched /browser/sessions forever. It is now self-scheduling and
  // demand-driven: 2 s while a human holds a lease (needed to notice a hand-back from the agent-browser panel
  // and the idle timeout), 5 s while someone watches the stream, and fully stopped otherwise. It is woken by
  // a new subscriber, a take or a lease change.
  const FAST_MS = 2000
  const WATCH_MS = 5000
  let reconcileTimer = null
  let reconcileBusy = false
  let reconcileDisposed = false
  const wantsReconcile = () => subscribers.size > 0 || [...leases.values()].some((lease) => lease.owner === 'human')
  async function reconcile() {
    if (reconcileBusy || !origin) return
    reconcileBusy = true
    try {
      const res = await fetch(`${origin}/browser/sessions`, { headers: { accept: 'application/json' } })
      if (!res.ok) return
      const inventory = await res.json()
      const rows = Array.isArray(inventory.sessions) ? inventory.sessions : []
      const live = new Map(rows.map((row) => [keyOf(row.name), row.takeover === true]))
      sessionNames = rows.map((row) => row.name ?? null)
      for (const [key, held] of live) {
        // A takeover started from dsh-agent-browser's own panel also pauses the agent.
        if (held && !isHuman(key)) {
          const lease = leaseOf(key)
          lease.owner = 'human'
          lease.since = Date.now()
        }
      }
      const idleMs = config.humanIdleMinutes * 60_000
      for (const [key, lease] of leases) {
        if (lease.owner !== 'human' || lease.request) continue
        const settled = Date.now() - lease.since > 5000
        const stoppedElsewhere = settled && live.get(key) !== true
        const idle = idleMs > 0 && Date.now() - lease.since > idleMs
        if (stoppedElsewhere || idle) await release(key, idle ? 'idle' : 'handback')
      }
      touch()
    } catch {
      // The web server may be restarting; try again next tick.
    } finally {
      reconcileBusy = false
    }
  }
  function arm() {
    if (reconcileTimer !== null) { clearTimeout(reconcileTimer); reconcileTimer = null }
    if (reconcileDisposed || !wantsReconcile()) return
    const human = [...leases.values()].some((lease) => lease.owner === 'human')
    reconcileTimer = setTimeout(async () => {
      reconcileTimer = null
      await reconcile()
      arm()
    }, human ? FAST_MS : WATCH_MS)
    reconcileTimer.unref?.()
  }
  /** Run a reconcile now and keep the loop going while it is still needed. */
  function wake() {
    void reconcile().finally(arm)
  }
  ctx.effect(() => () => {
    reconcileDisposed = true
    if (reconcileTimer !== null) clearTimeout(reconcileTimer)
  }, 'abx: reconcile takeover')

  // Hand every held lease back on unload so no tool call waits forever.
  ctx.effect(() => () => {
    for (const [key, lease] of leases) {
      lease.request?.resolve({ reason: 'cancelled' })
      lease.request = null
      if (lease.owner === 'human') void setForwarding(key, false)
      lease.owner = 'agent'
    }
  }, 'abx: release leases')
}
