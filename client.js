/**
 * dsh-agent-browser-takeover — client half.
 *
 * Registers a native right-sidebar tab "Agent browser" (through
 * dsh-better-sidebar's ctx.betterSidebar when present) showing the live
 * agent-browser viewport with a Take control / Hand back toggle. While the
 * user holds control, mouse, wheel, keyboard and paste are forwarded to the
 * page and the host refuses the agent's browser_* tools. A banner above the
 * composer appears whenever the agent is waiting on the user.
 */
window.__ModuleLoader__.load({
  id: 'dsh-agent-browser-takeover',
  factory(require) {
    const React = require('react')
    const { useCallback, useEffect, useRef, useState } = React
    const h = React.createElement
    const TAB_ID = 'dsh-agent-browser-takeover:browser'

    const EN = {
      tab: 'Agent browser',
      tabDescription: 'Watch the agent browse live and take control to sign in.',
      take: 'Take control',
      handBack: 'Hand back',
      agentDriving: 'Agent is driving',
      youDriving: 'You are in control — the agent is paused',
      waiting: 'The agent is waiting for you',
      noBrowser: 'This conversation has no browser running. Ask the agent to open a page.',
      thisConversation: 'This conversation',
      connecting: 'Connecting…',
      stale: 'stale',
      note: 'Optional note for the agent',
      persist: 'Hand back after signing in to share the login with every browser',
      openTab: 'Open browser',
      session: 'Session',
      idle: 'Control returns to the agent after {n} min without input.',
      keysHint: 'Click the page, then type. Ctrl+V pastes your clipboard.',
    }
    const t = (key, vars) => {
      let text = EN[key] ?? key
      if (vars) for (const [k, v] of Object.entries(vars)) text = text.replace(`{${k}}`, String(v))
      return text
    }

    async function getState() {
      try {
        const res = await fetch('/abx/state', { headers: { accept: 'application/json' }, cache: 'no-store' })
        return res.ok ? await res.json() : null
      } catch { return null }
    }
    async function postControl(session, action, note) {
      try {
        const res = await fetch('/abx/control', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ session, action, ...(note ? { note } : {}) }),
        })
        return res.ok ? await res.json() : null
      } catch { return null }
    }
    async function getSessions() {
      try {
        const res = await fetch('/browser/sessions', { headers: { accept: 'application/json' }, cache: 'no-store' })
        if (!res.ok) return null
        const body = await res.json()
        return Array.isArray(body.sessions) ? body.sessions.map((s) => s.name ?? null) : []
      } catch { return null }
    }

    /**
     * One shared connection to the host's /abx/events stream (server-sent events). Every hook instance
     * subscribes to the same state, so N mounted components cost one connection and, while idle, no requests.
     * The stream is only open while at least one subscriber is mounted AND the page is visible: a hidden page
     * closes it and a visible page reconnects (the first frame is the full state). If the stream cannot be
     * used (old host, proxy buffering) it degrades to a visibility-aware poll that backs off from 2.5 s to 15 s
     * while nothing changes.
     */
    const feed = (() => {
      const subs = new Set()
      let snapshot = { state: null, sessions: null }
      let source = null
      let fallbackTimer = null
      let fallbackDelay = 2500
      let failures = 0
      let lastSig = ''
      const publish = (next) => {
        const sig = JSON.stringify(next)
        if (sig === lastSig) return false
        lastSig = sig
        snapshot = next
        for (const fn of subs) fn(snapshot)
        return true
      }
      const apply = (body) => {
        if (!body || !Array.isArray(body.leases)) return false
        return publish({ state: { leases: body.leases, humanIdleMinutes: body.humanIdleMinutes }, sessions: Array.isArray(body.sessions) ? body.sessions.map((n) => n ?? null) : snapshot.sessions })
      }
      const stopSource = () => { if (source) { source.close(); source = null } }
      const stopFallback = () => { if (fallbackTimer !== null) { window.clearTimeout(fallbackTimer); fallbackTimer = null } }
      const pollOnce = async () => {
        const [next, names] = await Promise.all([getState(), getSessions()])
        if (!next) return false
        return publish({ state: { leases: next.leases ?? [], humanIdleMinutes: next.humanIdleMinutes }, sessions: names ?? snapshot.sessions })
      }
      const scheduleFallback = () => {
        stopFallback()
        if (subs.size === 0 || document.visibilityState === 'hidden' || source) return
        fallbackTimer = window.setTimeout(async () => {
          fallbackTimer = null
          const changed = await pollOnce()
          fallbackDelay = changed ? 2500 : Math.min(15000, Math.round(fallbackDelay * 1.6))
          scheduleFallback()
        }, fallbackDelay)
      }
      const connect = () => {
        if (source || subs.size === 0 || document.visibilityState === 'hidden') return
        if (typeof EventSource !== 'function' || failures >= 3) { fallbackDelay = 2500; void pollOnce().then(scheduleFallback); return }
        const es = new EventSource('/abx/events')
        source = es
        es.addEventListener('state', (ev) => {
          failures = 0
          try { apply(JSON.parse(ev.data)) } catch { /* ignore a malformed frame */ }
        })
        es.onerror = () => {
          // EventSource retries by itself (the host sends retry: 3000); only give up after repeated failures
          // that never delivered a frame, then fall back to polling.
          failures += 1
          if (failures >= 3) { stopSource(); connect() }
        }
      }
      const sync = () => {
        stopFallback()
        if (subs.size === 0 || document.visibilityState === 'hidden') { stopSource(); return }
        failures = 0
        stopSource()
        connect()
      }
      document.addEventListener('visibilitychange', sync)
      return {
        subscribe(fn) {
          subs.add(fn)
          fn(snapshot)
          if (subs.size === 1) sync()
          else if (!source && fallbackTimer === null) connect()
          return () => { subs.delete(fn); if (subs.size === 0) { stopSource(); stopFallback() } }
        },
        /** Fetch now (after an action the user just took) without waiting for a push. */
        async refresh() { await pollOnce() },
      }
    })()

    /** Lease state + browser session list, pushed by the host. */
    function useBrowserState(session) {
      const [snap, setSnap] = useState({ state: null, sessions: null })
      useEffect(() => feed.subscribe(setSnap), [])
      const refresh = useCallback(() => feed.refresh(), [])
      const key = session ?? null
      const lease = snap.state?.leases?.find((l) => (l.session ?? null) === key) ?? null
      return { state: snap.state, lease, sessions: snap.sessions, refresh }
    }

    const MODS = (ev) => (ev.altKey ? 1 : 0) | (ev.ctrlKey ? 2 : 0) | (ev.metaKey ? 4 : 0) | (ev.shiftKey ? 8 : 0)
    const BUTTON = (b) => (b === 2 ? 'right' : b === 1 ? 'middle' : 'left')
    const KEYCODES = { Backspace: 8, Tab: 9, Enter: 13, Escape: 27, ' ': 32, PageUp: 33, PageDown: 34, End: 35, Home: 36, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Delete: 46 }
    const keyCode = (ev) => KEYCODES[ev.key] ?? (ev.key.length === 1 ? ev.key.toUpperCase().charCodeAt(0) : 0)

    /** Live viewport: draws JPEG frames, forwards input while `control` is true. */
    function Viewport({ session, control, visible, onLive }) {
      const canvasRef = useRef(null)
      const wsRef = useRef(null)
      const lastMove = useRef(0)
      const [status, setStatus] = useState('connecting')
      const [age, setAge] = useState(null)

      useEffect(() => {
        if (!visible) return undefined
        let disposed = false
        let ws = null
        let retry = null
        let bitmap = null
        let lastFrameAt = 0
        const ticker = window.setInterval(() => { if (lastFrameAt && document.visibilityState !== 'hidden') setAge(Date.now() - lastFrameAt) }, 1000)
        const connect = () => {
          if (disposed) return
          // dsh-agent-browser's proxy forwards input only when the URL asks
          // for it AND its takeover flag is held, so reconnect on each change.
          const q = new URLSearchParams({ maxFps: '15', pacing: 'ack' })
          if (session) q.set('session', session)
          if (control) q.set('input', '1')
          const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
          ws = new WebSocket(`${proto}//${location.host}/browser/stream?${q}`)
          wsRef.current = ws
          ws.onopen = () => { setStatus('live'); onLive?.(true) }
          ws.onclose = () => {
            wsRef.current = null
            if (disposed) return
            setStatus('idle'); onLive?.(false)
            retry = window.setTimeout(connect, 2500)
          }
          ws.onerror = () => { try { ws.close() } catch { /* ignore */ } }
          ws.onmessage = async (ev) => {
            if (typeof ev.data !== 'string') return
            let msg
            try { msg = JSON.parse(ev.data) } catch { return }
            if (msg.type !== 'frame' || typeof msg.data !== 'string') return
            try {
              const bytes = Uint8Array.from(atob(msg.data), (c) => c.charCodeAt(0))
              const next = await createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }))
              const canvas = canvasRef.current
              if (canvas) {
                if (canvas.width !== next.width) canvas.width = next.width
                if (canvas.height !== next.height) canvas.height = next.height
                canvas.getContext('2d')?.drawImage(next, 0, 0)
              }
              bitmap?.close(); bitmap = next
              lastFrameAt = Date.now(); setAge(0)
            } catch { /* skip bad frame */ }
            if (typeof msg.seq === 'number' && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ack', seq: msg.seq }))
          }
        }
        connect()
        return () => {
          disposed = true
          window.clearInterval(ticker)
          if (retry) window.clearTimeout(retry)
          bitmap?.close()
          try { ws?.close() } catch { /* ignore */ }
          wsRef.current = null
        }
      }, [session, visible, control])

      const send = useCallback((msg) => {
        const ws = wsRef.current
        if (!control || !ws || ws.readyState !== WebSocket.OPEN) return
        ws.send(JSON.stringify(msg))
      }, [control])

      const point = (ev) => {
        const canvas = canvasRef.current
        const rect = canvas.getBoundingClientRect()
        // object-fit: contain — map through the letterboxed image box.
        const scale = Math.min(rect.width / canvas.width, rect.height / canvas.height)
        const w = canvas.width * scale
        const hgt = canvas.height * scale
        const ox = rect.left + (rect.width - w) / 2
        const oy = rect.top + (rect.height - hgt) / 2
        return {
          x: Math.round(Math.min(Math.max((ev.clientX - ox) / scale, 0), canvas.width - 1)),
          y: Math.round(Math.min(Math.max((ev.clientY - oy) / scale, 0), canvas.height - 1)),
        }
      }
      const mouse = (eventType) => (ev) => {
        if (!control) return
        if (eventType === 'mouseMoved') {
          const now = performance.now()
          if (now - lastMove.current < 33) return
          lastMove.current = now
        }
        if (eventType === 'mousePressed') canvasRef.current?.focus()
        const { x, y } = point(ev)
        send({ type: 'input_mouse', eventType, x, y, button: eventType === 'mouseMoved' ? 'none' : BUTTON(ev.button), clickCount: eventType === 'mouseMoved' ? 0 : Math.max(1, ev.detail || 1), modifiers: MODS(ev) })
      }
      const wheel = (ev) => {
        if (!control) return
        ev.preventDefault()
        const { x, y } = point(ev)
        send({ type: 'input_mouse', eventType: 'mouseWheel', x, y, button: 'none', clickCount: 0, deltaX: ev.deltaX, deltaY: ev.deltaY, modifiers: MODS(ev) })
      }
      const key = (eventType) => (ev) => {
        if (!control) return
        // Let Ctrl/Cmd+V reach onPaste so the clipboard text is inserted.
        if ((ev.ctrlKey || ev.metaKey) && (ev.key === 'v' || ev.key === 'V')) return
        ev.preventDefault(); ev.stopPropagation()
        const printable = ev.key.length === 1 && !ev.ctrlKey && !ev.metaKey && !ev.altKey
        send({
          type: 'input_keyboard', eventType, key: ev.key, code: ev.code,
          ...(eventType === 'keyDown' && printable ? { text: ev.key } : {}),
          windowsVirtualKeyCode: keyCode(ev), modifiers: MODS(ev),
        })
      }
      const paste = (ev) => {
        if (!control) return
        const text = ev.clipboardData?.getData('text/plain') ?? ''
        if (!text) return
        ev.preventDefault()
        send({ type: 'input_keyboard', eventType: 'keyDown', key: 'Unidentified', code: '', text })
        send({ type: 'input_keyboard', eventType: 'keyUp', key: 'Unidentified', code: '' })
      }

      const stale = status === 'live' && age !== null && age > 4000
      return h('div', { style: { position: 'relative', flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', gap: 4 } },
        h('canvas', {
          ref: canvasRef, width: 1280, height: 720, tabIndex: 0,
          'aria-label': t('tab'),
          style: {
            flex: 1, minHeight: 0, width: '100%', height: '100%', objectFit: 'contain', borderRadius: 8,
            background: 'var(--dsw-alias-bg-layer-2)', outline: control ? '2px solid var(--dsw-alias-state-warn-primary)' : '1px solid var(--dsw-alias-border-l1)',
            cursor: control ? 'default' : 'not-allowed',
          },
          onMouseDown: mouse('mousePressed'), onMouseUp: mouse('mouseReleased'), onMouseMove: control ? mouse('mouseMoved') : undefined,
          onWheel: control ? wheel : undefined, onKeyDown: key('keyDown'), onKeyUp: key('keyUp'), onPaste: paste,
          onContextMenu: (e) => { if (control) e.preventDefault() },
        }),
        h('div', { style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)', display: 'flex', gap: 8 } },
          h('span', null, status === 'live' ? (stale ? `${t('stale')} ${Math.round(age / 1000)}s` : 'live') : status === 'connecting' ? t('connecting') : status),
          control ? h('span', null, t('keysHint')) : null),
      )
    }

    const btn = (primary) => ({
      cursor: 'pointer', fontSize: 12, fontWeight: 600, padding: '6px 12px', borderRadius: 8,
      border: `1px solid ${primary ? 'transparent' : 'var(--dsw-alias-border-l2)'}`,
      background: primary ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-bg-layer-1)',
      color: primary ? '#fff' : 'var(--dsw-alias-label-primary)',
    })

    /** Same derivation as the host: this conversation's own browser session name. */
    function conversationSession(sessionId) {
      const id = String(sessionId ?? '').replace(/^session-/, '').replace(/[^A-Za-z0-9_-]/g, '')
      return id.length > 0 ? `c-${id.slice(0, 12)}` : null
    }

    function BrowserTab({ visible, conversation }) {
      const own = conversationSession(conversation)
      const [session, setSession] = useState(own)
      // Switching conversations switches to that conversation's browser.
      useEffect(() => { setSession(own) }, [own])
      const [note, setNote] = useState('')
      const [error, setError] = useState(null)
      const [live, setLive] = useState(false)
      const { state, lease, sessions, refresh } = useBrowserState(session)
      const human = lease?.owner === 'human'
      const request = lease?.request ?? null
      const toggle = async () => {
        setError(null)
        const result = await postControl(session, human ? 'release' : 'take', human && note.trim() ? note.trim() : undefined)
        if (!result?.ok) setError(result?.error ?? 'Request failed')
        if (human) setNote('')
        await refresh()
      }
      // This conversation's browser first, then any others still running.
      const names = [...new Set([own, ...(Array.isArray(sessions) ? sessions : [])].filter((n) => n !== undefined))]
      const ownRunning = Array.isArray(sessions) && sessions.includes(session)

      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8, padding: 10, height: '100%', minHeight: 0, boxSizing: 'border-box', color: 'var(--dsw-alias-label-primary)' } },
        request ? h('div', { role: 'status', style: { padding: '8px 10px', borderRadius: 8, background: 'var(--dsw-alias-bg-layer-1)', border: '1px solid var(--dsw-alias-state-warn-primary)', fontSize: 12, lineHeight: 1.4 } },
          h('div', { style: { fontWeight: 600, marginBottom: 2 } }, t('waiting')),
          h('div', null, request.reason)) : null,
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
          h('span', {
            style: {
              display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 600,
              color: human ? 'var(--dsw-alias-state-warn-primary)' : 'var(--dsw-alias-label-secondary)',
            },
          }, h('span', { style: { width: 8, height: 8, borderRadius: 4, background: human ? 'var(--dsw-alias-state-warn-primary)' : live ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-state-idle-primary)' } }),
          human ? t('youDriving') : t('agentDriving')),
          h('span', { style: { flex: 1 } }),
          names.length > 1 ? h('select', {
            'aria-label': t('session'), value: session ?? '', onChange: (e) => setSession(e.target.value || null),
            style: { fontSize: 12, padding: '4px 6px', borderRadius: 6, background: 'var(--dsw-alias-bg-layer-1)', color: 'inherit', border: '1px solid var(--dsw-alias-border-l1)' },
          }, names.map((n) => h('option', { key: n ?? '', value: n ?? '' }, n === own ? t('thisConversation') : (n ?? 'default')))) : null,
          h('button', { type: 'button', onClick: toggle, disabled: !ownRunning && !human, style: { ...btn(!human || Boolean(request)), opacity: !ownRunning && !human ? 0.5 : 1 } }, human ? t('handBack') : t('take')),
        ),
        error ? h('div', { role: 'alert', style: { fontSize: 12, color: 'var(--dsw-alias-state-error-primary)' } }, error) : null,
        human ? h('input', {
          value: note, placeholder: t('note'), onChange: (e) => setNote(e.target.value),
          onKeyDown: (e) => { if (e.key === 'Enter') { e.preventDefault(); void toggle() } },
          style: { fontSize: 12, padding: '6px 8px', borderRadius: 6, background: 'var(--dsw-alias-bg-layer-1)', color: 'inherit', border: '1px solid var(--dsw-alias-border-l1)' },
        }) : null,
        ownRunning || human
          ? h(Viewport, { session, control: human, visible: Boolean(visible), onLive: setLive })
          : h('div', { style: { flex: 1, fontSize: 12, color: 'var(--dsw-alias-label-secondary)', padding: '24px 4px', textAlign: 'center' } }, t('noBrowser')),
        h('div', { style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)', display: 'flex', gap: 10, flexWrap: 'wrap' } },
          h('span', null, t('persist')),
          human && state?.humanIdleMinutes && !request ? h('span', null, t('idle', { n: state.humanIdleMinutes })) : null),
      )
    }

    /** Banner above the composer while the agent waits for the user. */
    function WaitingBanner({ onOpen, sessionId }) {
      const { state } = useBrowserState(null)
      // Only this conversation's request (its agent, or its own browser session).
      const own = conversationSession(sessionId)
      const request = state?.leases?.find((l) => l.request
        && (l.request.agentSessionId === sessionId || l.session === own))?.request
      if (!request) return null
      return h('div', {
        role: 'status',
        style: {
          display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px', margin: '0 0 6px', borderRadius: 10, fontSize: 12,
          background: 'var(--dsw-alias-bg-layer-1)', border: '1px solid var(--dsw-alias-state-warn-primary)', color: 'var(--dsw-alias-label-primary)',
        },
      },
      h('span', { style: { fontWeight: 600, whiteSpace: 'nowrap' } }, t('waiting')),
      h('span', { style: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, title: request.reason }, request.reason),
      onOpen ? h('button', { type: 'button', onClick: onOpen, style: btn(true) }, t('openTab')) : null)
    }

    function Icon(size) {
      return h('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
        h('rect', { x: 3, y: 4, width: 18, height: 14, rx: 2 }),
        h('path', { d: 'M3 8h18' }),
        h('path', { d: 'M12 12.5l3 5.5-1.6.2.9 1.8-1 .5-.9-1.8-1.2 1z', fill: 'currentColor', stroke: 'none' }))
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        let openTab = null
        ctx.slots.inject('conversation.input.dock', () => ctx.slots.register(
          { name: 'conversation.input.dock', id: 'agent-browser-takeover', order: 22 },
          ({ sessionId }) => h(WaitingBanner, { sessionId, onOpen: openTab ? () => openTab(sessionId) : undefined }),
        ))
        // betterSidebar is optional: a static inject would leave this plugin
        // pending (and the boot waiting) on hosts without it.
        ctx.plugin({
          inject: ['betterSidebar'],
          apply(sideCtx) {
            const sidebar = sideCtx.betterSidebar
            // With a sessionId the tab opens in THAT conversation's sidebar.
            openTab = (sessionId) => sidebar.openTab({ type: TAB_ID, target: 'right' }, sessionId ? { sessionId } : undefined)
            sideCtx.effect(() => sidebar.registerTab({
              id: TAB_ID,
              title: () => t('tab'),
              description: () => t('tabDescription'),
              icon: (size) => Icon(Math.max(12, size)),
              order: 45,
              single: true,
              component: ({ visible, scope }) => h(BrowserTab, { visible, conversation: scope?.sessionId }),
            }), 'abx: sidebar tab')
            // Pop the tab open, in the asking conversation's sidebar, when an
            // agent asks for help. Each request opens it once.
            const opened = new Set()
            sideCtx.effect(() => {
              const unsubscribe = feed.subscribe((snap) => {
                for (const lease of snap.state?.leases ?? []) {
                  const req = lease.request
                  if (!req) continue
                  const id = `${req.agentSessionId ?? lease.session ?? ''}:${req.at}`
                  if (opened.has(id)) continue
                  opened.add(id)
                  try { openTab(req.agentSessionId ?? undefined) } catch { /* ignore */ }
                }
              })
              return () => { unsubscribe(); openTab = null }
            }, 'abx: auto-open on request')
          },
        })
      },
    }
  },
})
