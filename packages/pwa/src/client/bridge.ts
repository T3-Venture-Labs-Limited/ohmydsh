// Always-on, UI-less half of the client: lets the service worker (a) ask which session this window shows and (b) open a
// session when a notification is clicked, and turns a `?share=<id>` / `?openSession=<id>` landing into the right view.
// Only public client API is used: `uiWorkspace.openSession(id)` (what dsh-notify-me uses for its own clicks) and
// `uiWorkspace.startSession(undefined, { prompt })` (the "new session with a draft" entry the host's own UI uses), whose
// prompt lands in the composer as a draft and is never sent.

export interface ShareRecord {
  readonly title: string
  readonly text: string
  readonly url: string
  readonly files: readonly { readonly name: string; readonly path: string }[]
}

export interface BridgeDeps {
  readonly openSession: (sessionId: string) => void
  readonly startDraft: (prompt: string) => void
  readonly currentSessionId: () => string
  readonly location: Pick<Location, 'pathname' | 'search' | 'hash'>
  readonly replaceUrl: (url: string) => void
  readonly fetchShare: (id: string) => Promise<ShareRecord | undefined>
  readonly isShareableReady: () => Promise<boolean>
  readonly worker: { addEventListener(type: 'message', fn: (event: MessageEvent) => void): void; removeEventListener(type: 'message', fn: (event: MessageEvent) => void): void } | undefined
}

const SESSION_ID = /^[A-Za-z0-9_-]{1,80}$/
const SHARE_ID = /^[a-f0-9]{24}$/

/** The text pre-filled into the composer for one share: title, text, link (no repeats), then the saved file paths. */
export function draftFromShare(share: ShareRecord): string {
  const lines: string[] = []
  for (const part of [share.title, share.text, share.url]) {
    const trimmed = part.trim()
    if (trimmed !== '' && !lines.some((line) => line.includes(trimmed))) lines.push(trimmed)
  }
  if (share.files.length > 0) lines.push('', ...share.files.map((file) => `Shared file: ${file.path}`))
  return lines.join('\n').trim()
}

/** Removes `?openSession=` / `?share=` from the address bar so a reload does not repeat the action. */
export function cleanUrl(location: BridgeDeps['location']): string {
  const params = new URLSearchParams(location.search)
  params.delete('openSession')
  params.delete('share')
  const query = params.toString()
  return `${location.pathname}${query === '' ? '' : `?${query}`}${location.hash}`
}

/** Wire the bridge; returns a disposer. */
export function startBridge(deps: BridgeDeps): () => void {
  const onMessage = (event: MessageEvent): void => {
    const data = (event.data ?? {}) as { type?: unknown; sessionId?: unknown }
    if (data.type === 'dsh-pwa:current-session') {
      event.ports[0]?.postMessage({ sessionId: deps.currentSessionId() })
    } else if (data.type === 'dsh-pwa:open-session' && typeof data.sessionId === 'string' && SESSION_ID.test(data.sessionId)) {
      deps.openSession(data.sessionId)
    }
  }
  deps.worker?.addEventListener('message', onMessage)

  const params = new URLSearchParams(deps.location.search)
  const openSession = params.get('openSession')
  const shareId = params.get('share')
  if (openSession !== null || shareId !== null) deps.replaceUrl(cleanUrl(deps.location))
  let alive = true
  if (openSession !== null && SESSION_ID.test(openSession)) {
    void deps.isShareableReady().then((ready) => { if (alive && ready) deps.openSession(openSession) })
  }
  if (shareId !== null && SHARE_ID.test(shareId)) {
    void (async () => {
      const share = await deps.fetchShare(shareId)
      if (!alive || share === undefined || !(await deps.isShareableReady()) || !alive) return
      const prompt = draftFromShare(share)
      if (prompt !== '') deps.startDraft(prompt)
    })()
  }
  return () => { alive = false; deps.worker?.removeEventListener('message', onMessage) }
}
