/**
 * One-time (and on-demand) import of agent media that already exists: image attachments and announced videos in the tool results of
 * existing sessions, then the files in the subscriptions plugin's `images` and `videos` folders. Idempotent (content addressed), never
 * deletes or moves a source file, and never leaves its allowed roots.
 */
import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { resolveDshHome } from '../vault-store.js'
import { AgentCapture, isCollectable, addOutcome, emptyTally, extractMedia, callInfoOf, IMAGE_EXTENSIONS, VIDEO_EXTENSIONS, type CallInfo, type CaptureTally } from './agent-capture.js'
import { extname } from 'node:path'
import type { StudioCore } from './core.js'

export const BACKFILL_KEY = 'agent-backfill:v1'
const MAX_SESSIONS = 2000
const MAX_FILES_PER_DIR = 5000

/** What the backfill needs from the host's session history. Optional: without it only the media folders are scanned. */
export interface SessionHistory {
  list(): Promise<{ id: string; cwd?: string }[]>
  read(id: string): Promise<{ cwd?: string; events: readonly { type: string; time?: number; data?: unknown }[] }>
}

export interface BackfillSummary extends CaptureTally {
  /** Sessions whose tool results were scanned, or `undefined` when session history was not available. */
  sessionsScanned?: number
  filesScanned: number
  at: number
}

export interface BackfillDone { at: number; summary: BackfillSummary }

export const readBackfillMarker = (core: StudioCore): BackfillDone | undefined => {
  const raw = core.db.getSetting(BACKFILL_KEY)
  if (raw === undefined) return undefined
  try { return JSON.parse(raw) as BackfillDone } catch { return undefined }
}

export async function runBackfill(core: StudioCore, capture: AgentCapture, options: { home?: string; history?: SessionHistory | undefined; now?: () => number; yieldMs?: number } = {}): Promise<BackfillSummary> {
  const tally = emptyTally()
  let sessionsScanned: number | undefined
  let filesScanned = 0
  const pause = (): Promise<void> => new Promise(resolve => setTimeout(resolve, options.yieldMs ?? 5))

  // 1) Session history first: it carries the session, workspace, prompt and model, which a bare file does not.
  if (options.history !== undefined) {
    sessionsScanned = 0
    try {
      for (const record of (await options.history.list()).slice(0, MAX_SESSIONS)) {
        try {
          const log = await options.history.read(record.id)
          const calls = new Map<string, CallInfo>()
          let any = false
          for (const event of log.events) {
            if (event.type === 'tool/call') {
              const d = event.data as { callId?: unknown; name?: unknown; arguments?: unknown } | undefined
              if (typeof d?.callId === 'string' && typeof d.name === 'string') calls.set(d.callId, callInfoOf(d.name, d.arguments))
            } else if (event.type === 'tool/result') {
              const message = (event.data as { message?: { toolCallId?: unknown; content?: unknown; isError?: boolean } } | undefined)?.message
              if (message === undefined || message.isError === true) continue
              const call = typeof message.toolCallId === 'string' ? calls.get(message.toolCallId) : undefined
              if (call === undefined || !isCollectable(call.name)) continue
              const media = extractMedia(message.content)
              if (media.images.length === 0 && media.videoPaths.length === 0) continue
              any = true
              const cwd = log.cwd ?? record.cwd
              for (const outcome of await capture.collect(media, { ...call, sessionId: record.id, ...(cwd === undefined ? {} : { cwd }), ...(event.time === undefined ? {} : { time: event.time }) })) addOutcome(tally, outcome)
            }
          }
          sessionsScanned++
          if (any) await pause()
        } catch { tally.failed++ /* one unreadable session must not stop the rest */ }
      }
    } catch { /* history unavailable: the folders below still run */ }
  }

  // 2) The subscriptions plugin's own folders: every file the agent tools wrote, whether or not a session still mentions it.
  const home = resolveDshHome(options.home)
  for (const [folder, kind, tool] of [['images', 'image', 'image_generate'], ['videos', 'video', 'video_generate']] as const) {
    const dir = join(home, 'plugins', 'subscriptions', folder)
    let names: string[]
    try { names = (await readdir(dir)).slice(0, MAX_FILES_PER_DIR) } catch { continue }
    const allowed = kind === 'video' ? VIDEO_EXTENSIONS : IMAGE_EXTENSIONS
    for (const name of names.sort()) {
      if (!allowed.includes(extname(name).toLowerCase())) continue
      filesScanned++
      const path = join(dir, name)
      let mtime: number | undefined
      try { const s = await stat(path); if (!s.isFile()) continue; mtime = Math.round(s.mtimeMs) } catch { continue }
      addOutcome(tally, await capture.importLocalFile(path, { name: tool, time: mtime }, kind))
    }
  }

  const summary: BackfillSummary = { ...tally, ...(sessionsScanned === undefined ? {} : { sessionsScanned }), filesScanned, at: (options.now ?? Date.now)() }
  core.db.setSetting(BACKFILL_KEY, JSON.stringify({ at: summary.at, summary } satisfies BackfillDone))
  return summary
}
