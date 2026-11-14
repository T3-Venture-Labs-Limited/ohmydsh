/* /m: light read-and-reply phone view for DeepSeek Harness. Vanilla JS, no dependencies, English-only.
 * Auth: the same HttpOnly cookie as the full UI (same-origin fetch / WebSocket). Reads and writes use the HTTP RPC
 * (POST /api/<namespace>/<method>); live updates and approvals use one multiplexed WebSocket (/api/remote.mux) that
 * is closed while the page is hidden. Nothing is polled. All text is inserted with textContent. */
'use strict'
;(function () {
  var T = {
    title: 'DSH', sessions: 'Sessions', approvals: 'Approvals', back: 'Back', refresh: 'Refresh', newSession: 'New',
    emptySessions: 'No sessions yet. Tap New to start one.', emptyApprovals: 'Nothing is waiting for you.',
    placeholder: 'Reply…', send: 'Send', stop: 'Stop', allow: 'Allow once', reject: 'Reject', loadOlder: 'Load older', showAll: 'Show all',
    working: 'Working…', offline: 'Reconnecting…', connected: 'Live', signedOut: 'Signed out. Open the DSH link with its token once on this device, then reload.',
    failed: 'Something went wrong: ', toolPrefix: 'Used ', approvalFor: 'Approval needed', sharedTitle: 'Shared to DSH', startSession: 'Start session',
    sharedHint: 'Review, then start a session with this content.', discard: 'Discard', sessionFallback: 'Session', untitled: 'New conversation',
    justNow: 'just now', agoMin: ' min ago', agoHour: ' h ago', agoDay: ' d ago', files: 'Files saved: '
  }

  var $app = document.getElementById('app')
  var state = {
    tab: 'sessions', list: null, current: null, messages: [], more: false, cursorSeq: null, running: false,
    approvals: [], expanded: {}, titles: {}, status: 'connecting', error: '', share: null, clientId: null, draft: ''
  }

  // ── DOM helpers (text only) ──────────────────────────────────────────────
  function h(tag, props) {
    var el = document.createElement(tag)
    props = props || {}
    for (var k in props) {
      var v = props[k]
      if (v == null || v === false) continue
      if (k === 'class') el.className = v
      else if (k === 'text') el.textContent = v
      else if (k.slice(0, 2) === 'on') el.addEventListener(k.slice(2), v)
      else el.setAttribute(k, v === true ? '' : String(v))
    }
    for (var i = 2; i < arguments.length; i++) {
      var c = arguments[i]
      if (c == null || c === false) continue
      el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c)
    }
    return el
  }

  // ── HTTP RPC ─────────────────────────────────────────────────────────────
  function uuid() { return (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2)) }
  function rpc(endpoint, args, signal) {
    var rpcId = uuid()
    return fetch('/api/' + endpoint, {
      method: 'POST', credentials: 'same-origin', signal: signal,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: rpcId, method: endpoint, payload: { args: args || {} } })
    }).then(function (res) {
      if (res.status === 401 || res.status === 403) { fail(T.signedOut); throw new Error('auth') }
      if (!res.ok) throw new Error('HTTP ' + res.status)
      return res.json()
    }).then(function (body) {
      if (!body || body.type !== 'server-response' || body.rpcId !== rpcId) throw new Error('bad response')
      if (!body.result.ok) throw new Error(body.result.error && body.result.error.message || 'request failed')
      return body.result.value
    })
  }
  function fail(message) { state.error = message; render() }
  function guard(promise) {
    return promise.then(function (v) { if (state.error && state.error.indexOf(T.failed) === 0) { state.error = ''; render() } return v }, function (e) {
      if (e && e.message === 'auth') return undefined
      fail(T.failed + (e && e.message || e)); return undefined
    })
  }

  // ── Mux WebSocket: logical streams over /api/remote.mux; closed while hidden ──
  var mux = { ws: null, streams: {}, wanted: {}, timer: null, backoff: 500 }
  function muxUrl() { var u = new URL('/api/remote.mux', location.href); u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:'; return u.href }
  function muxSend(msg) { if (mux.ws && mux.ws.readyState === 1) mux.ws.send(JSON.stringify(msg)) }
  function muxConnect() {
    if (mux.ws || document.visibilityState === 'hidden') return
    var ws = new WebSocket(muxUrl())
    mux.ws = ws
    ws.onopen = function () {
      mux.backoff = 500; setStatus('live')
      Object.keys(mux.wanted).forEach(function (key) { startStream(key) })
    }
    ws.onmessage = function (ev) {
      var msg; try { msg = JSON.parse(ev.data) } catch (e) { return }
      var s = mux.streams[msg.streamId]; if (!s) return
      if (msg.type === 'item') s.onItem(msg.value)
      else if (msg.type === 'error' || msg.type === 'end') { delete mux.streams[msg.streamId]; if (s.onEnd) s.onEnd(msg.error) }
    }
    ws.onclose = function () {
      mux.ws = null; mux.streams = {}
      if (document.visibilityState === 'hidden') { setStatus('paused'); return }
      setStatus('connecting')
      clearTimeout(mux.timer); mux.timer = setTimeout(muxConnect, mux.backoff); mux.backoff = Math.min(mux.backoff * 2, 10000)
    }
    ws.onerror = function () { try { ws.close() } catch (e) { /* ignore */ } }
  }
  function startStream(key) {
    var w = mux.wanted[key]; if (!w || !mux.ws || mux.ws.readyState !== 1) return
    var streamId = uuid()
    mux.streams[streamId] = { onItem: w.onItem, onEnd: w.onEnd }
    w.streamId = streamId
    muxSend({ type: 'open', streamId: streamId, endpoint: w.endpoint, payload: { args: w.args } })
  }
  function openStream(key, endpoint, args, onItem, onEnd) {
    mux.wanted[key] = { endpoint: endpoint, args: args, onItem: onItem, onEnd: onEnd }
    startStream(key); muxConnect()
  }
  function closeStream(key) {
    var w = mux.wanted[key]; if (!w) return
    delete mux.wanted[key]
    if (w.streamId) { muxSend({ type: 'cancel', streamId: w.streamId }); delete mux.streams[w.streamId] }
  }
  function muxClose() { clearTimeout(mux.timer); if (mux.ws) { try { mux.ws.close() } catch (e) { /* ignore */ } } }
  function setStatus(s) { if (state.status !== s) { state.status = s; renderStatus() } }

  // ── Data ─────────────────────────────────────────────────────────────────
  function titleOf(item) {
    var t = item.projections && item.projections.values && item.projections.values.title
    if (t) return String(t)
    if (item.cwd) return item.cwd.split('/').filter(Boolean).pop() || T.untitled
    return T.untitled
  }
  function loadList() {
    return guard(rpc('session/list', { _request: {} })).then(function (v) {
      if (!v) return
      var items = v.items.filter(function (i) { return i.origin !== 'subagent' && !i.blank })
      items.sort(function (a, b) { return b.updatedAt - a.updatedAt })
      state.list = items
      items.forEach(function (i) { state.titles[i.sessionId] = titleOf(i) })
      if (state.current) { var cur = items.find(function (i) { return i.sessionId === state.current }); if (cur) state.running = !!cur.running }
      render()
    })
  }
  var listTimer = null
  function loadListSoon() { clearTimeout(listTimer); listTimer = setTimeout(loadList, 400) }

  var parseEvents = window.PwaEvents.parseEvents
  function mergeMessages(extra) {
    var bySeq = {}
    state.messages.concat(extra).forEach(function (m) { bySeq[m.seq] = m })
    state.messages = Object.keys(bySeq).map(function (k) { return bySeq[k] }).sort(function (a, b) { return a.seq - b.seq })
  }
  function openSession(id) {
    state.current = id; state.messages = []; state.more = false; state.cursorSeq = null; state.running = false
    var cur = (state.list || []).find(function (i) { return i.sessionId === id }); if (cur) state.running = !!cur.running
    render()
    return loadHistory(false).then(function () {
      openStream('session', 'session/observeEvent', { request: { address: { kind: 'session', sessionId: id } } }, function (frame) {
        if (frame && frame.type === 'event') {
          var added = parseEvents([frame]); if (added.length) { mergeMessages(added); render(true) }
          if (/^(turn|step)\//.test(frame.event.type)) loadListSoon()
        }
      })
    })
  }
  function loadHistory(older) {
    var req = { address: { kind: 'session', sessionId: state.current }, maxMessages: 30 }
    if (older && state.cursorSeq != null) req.beforeSeq = state.cursorSeq
    return guard(rpc('session/events', { request: req })).then(function (page) {
      if (!page) return
      var recs = page.records || []
      if (recs.length) { var low = Math.min.apply(null, recs.map(function (r) { return r.event.seq })); state.cursorSeq = state.cursorSeq == null ? low : Math.min(state.cursorSeq, low) }
      state.more = !!page.hasMore
      mergeMessages(parseEvents(recs)); render(!older)
    })
  }
  function closeSession() {
    closeStream('session'); state.current = null; state.messages = []; history.replaceState(null, '', '#/'); render(); loadList()
  }

  // ── Actions ──────────────────────────────────────────────────────────────
  function sendPrompt(text) {
    text = text.trim(); if (!text || !state.current) return Promise.resolve()
    return guard(rpc('session/prompt', { request: { requestId: uuid(), sessionId: state.current, mode: 'queue', content: [{ type: 'text', text: text }], clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone } }))
  }
  function newSession(cwd) {
    return guard(rpc('session/create', { request: cwd ? { cwd: cwd } : {} })).then(function (v) { return v && v.sessionId })
  }
  function cancelTurn() { if (state.current) guard(rpc('session/cancel', { request: { sessionId: state.current } })) }

  // ── Approvals (forwarded waterfall events on the $events stream) ──
  function eventsItem(frame) {
    if (!frame) return
    if (frame.type === 'ready') { state.clientId = frame.clientId; return }
    if (frame.type === 'emit') { if (/^api-session\//.test(frame.event)) loadListSoon(); return }
    if (frame.type === 'cancel') { state.approvals = state.approvals.filter(function (a) { return a.eventId !== frame.eventId }); render(); return }
    if (frame.type === 'waterfall') {
      if (frame.event === 'approval/request') {
        var r = frame.request || {}
        state.approvals.push({ eventId: frame.eventId, sessionId: frame.agentId, tool: r.toolName || 'tool', reason: (r.displayReason && r.displayReason.en) || r.reason || '' })
        render()
        if (document.visibilityState === 'hidden' && 'Notification' in window && Notification.permission === 'granted') {
          try { new Notification(T.approvalFor, { body: String(r.toolName || '') }) } catch (e) { /* ignore */ }
        }
      } else {
        // Not ours to answer: pass it on so the next listener (the full UI) decides.
        answerEvent(frame.eventId, { kind: 'next' })
      }
    }
  }
  function answerEvent(eventId, outcome) {
    if (!state.clientId) return Promise.resolve()
    return rpc('$events/result', { clientId: state.clientId, eventId: eventId, outcome: outcome })
  }
  function decide(a, decision) {
    state.approvals = state.approvals.filter(function (x) { return x.eventId !== a.eventId }); render()
    guard(answerEvent(a.eventId, { kind: 'result', value: decision }))
  }

  // ── Rendering ────────────────────────────────────────────────────────────
  function ago(ms) {
    var s = Math.max(0, (Date.now() - ms) / 1000)
    if (s < 60) return T.justNow
    if (s < 3600) return Math.floor(s / 60) + T.agoMin
    if (s < 86400) return Math.floor(s / 3600) + T.agoHour
    return Math.floor(s / 86400) + T.agoDay
  }
  var $status = null, $main = null
  function renderStatus() {
    if ($status) $status.textContent = state.status === 'live' ? T.connected : state.status === 'paused' ? '' : T.offline
  }
  function approvalCard(a) {
    return h('div', { class: 'pwa-card pwa-card--warn', role: 'group', 'aria-label': T.approvalFor },
      h('h3', { text: a.tool }),
      h('p', { text: (state.titles[a.sessionId] ? state.titles[a.sessionId] + '\n' : '') + (a.reason || '') }),
      h('div', { class: 'pwa-card__actions' },
        h('button', { class: 'pwa-btn', type: 'button', text: T.reject, onclick: function () { decide(a, 'rejected') } }),
        h('button', { class: 'pwa-btn pwa-btn--primary', type: 'button', text: T.allow, onclick: function () { decide(a, 'allowed-once') } })))
  }
  function renderList() {
    var wrap = h('div')
    if (state.tab === 'approvals') {
      if (!state.approvals.length) wrap.appendChild(h('p', { class: 'pwa-note', text: T.emptyApprovals }))
      state.approvals.forEach(function (a) { wrap.appendChild(approvalCard(a)) })
      return wrap
    }
    state.approvals.forEach(function (a) { wrap.appendChild(approvalCard(a)) })
    if (state.list == null) { wrap.appendChild(h('p', { class: 'pwa-note', text: '…' })); return wrap }
    if (!state.list.length) wrap.appendChild(h('p', { class: 'pwa-note', text: T.emptySessions }))
    var ul = h('ul', { class: 'pwa-list' })
    state.list.forEach(function (i) {
      var asking = state.approvals.some(function (a) { return a.sessionId === i.sessionId })
      ul.appendChild(h('li', null, h('button', { class: 'pwa-row', type: 'button', onclick: function () { location.hash = '#/s/' + i.sessionId } },
        h('span', { class: 'pwa-row__top' }, h('span', { class: 'pwa-dot' + (asking ? ' pwa-dot--ask' : i.running ? ' pwa-dot--running' : '') }), h('span', { class: 'pwa-row__title', text: titleOf(i) })),
        h('span', { class: 'pwa-row__meta', text: ago(i.updatedAt) + (i.running ? ' · ' + T.working : '') + (i.cwd ? ' · ' + i.cwd.split('/').filter(Boolean).pop() : '') }))))
    })
    wrap.appendChild(ul)
    return wrap
  }
  function renderSession() {
    var wrap = h('div', { class: 'pwa-msgs' })
    if (state.more) wrap.appendChild(h('button', { class: 'pwa-btn pwa-more', type: 'button', text: T.loadOlder, onclick: function () { loadHistory(true) } }))
    state.messages.forEach(function (m) {
      var long = m.text.length > 900 && !state.expanded[m.seq]
      var bubble = h('div', { class: 'pwa-msg pwa-msg--' + m.role, text: long ? m.text.slice(0, 900) + '…' : m.text })
      wrap.appendChild(bubble)
      if (long) wrap.appendChild(h('button', { class: 'pwa-btn pwa-more', type: 'button', text: T.showAll, onclick: function () { state.expanded[m.seq] = true; render() } }))
    })
    if (state.running) wrap.appendChild(h('div', { class: 'pwa-msg pwa-msg--tool', text: T.working }))
    state.approvals.filter(function (a) { return a.sessionId === state.current }).forEach(function (a) { wrap.appendChild(approvalCard(a)) })
    return wrap
  }
  function renderShare() {
    var s = state.share
    var body = [s.title, s.text, s.url].filter(Boolean).join('\n')
    var ta = h('textarea', { class: 'pwa-input', rows: 5, 'aria-label': T.sharedTitle }); ta.value = state.draft || body
    ta.addEventListener('input', function () { state.draft = ta.value })
    var files = s.files && s.files.length ? h('p', { class: 'pwa-note', text: T.files + s.files.map(function (f) { return f.name }).join(', ') }) : null
    return h('div', { class: 'pwa-card' }, h('h3', { text: T.sharedTitle }), h('p', { text: T.sharedHint }), ta, files,
      h('div', { class: 'pwa-card__actions', style: 'margin-top:10px' },
        h('button', { class: 'pwa-btn', type: 'button', text: T.discard, onclick: function () { state.share = null; state.draft = ''; history.replaceState(null, '', '/m#/'); render() } }),
        h('button', { class: 'pwa-btn pwa-btn--primary', type: 'button', text: T.startSession, onclick: function () { startFromShare(ta.value) } })))
  }
  function startFromShare(text) {
    var s = state.share
    var lines = [text.trim()]
    if (s.files && s.files.length) lines.push('', 'Files shared from the phone:', ...s.files.map(function (f) { return '- ' + f.path }))
    var content = lines.join('\n').trim()
    newSession(s.cwd || undefined).then(function (id) {
      if (!id) return
      state.share = null; state.draft = ''
      var go = function () { location.hash = '#/s/' + id }
      if (s.mode === 'session') { state.current = id; sendPrompt(content).then(go) }
      else { sessionStorage.setItem('draft:' + id, content); go() }
    })
  }

  function render(stickBottom) {
    var scroller = $main, atBottom = scroller ? scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 80 : true
    var children = []
    if (state.current) {
      var bar = h('div', { class: 'pwa-bar' },
        h('button', { class: 'pwa-btn', type: 'button', 'aria-label': T.back, text: '‹', onclick: function () { location.hash = '#/' } }),
        h('h1', { class: 'pwa-title', text: state.titles[state.current] || T.sessionFallback }),
        state.running ? h('button', { class: 'pwa-btn', type: 'button', text: T.stop, onclick: cancelTurn }) : null)
      $main = h('main', { class: 'pwa-main' }, state.error ? h('div', { class: 'pwa-error', role: 'alert', text: state.error }) : null, renderSession())
      var ta = h('textarea', { class: 'pwa-input', rows: 1, placeholder: T.placeholder, 'aria-label': T.placeholder, enterkeyhint: 'send' })
      ta.value = state.draft || sessionStorage.getItem('draft:' + state.current) || ''
      ta.addEventListener('input', function () { state.draft = ta.value; ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, window.innerHeight * 0.38) + 'px' })
      var send = h('button', { class: 'pwa-btn pwa-btn--primary', type: 'button', text: T.send, onclick: function () {
        var text = ta.value; if (!text.trim()) return
        ta.value = ''; state.draft = ''; sessionStorage.removeItem('draft:' + state.current); ta.style.height = 'auto'
        sendPrompt(text)
      } })
      $status = h('div', { class: 'pwa-status', 'aria-live': 'polite' })
      children = [bar, $main, $status, h('div', { class: 'pwa-composer' }, ta, send)]
    } else {
      var count = state.approvals.length
      var bar2 = h('div', { class: 'pwa-bar' }, h('h1', { class: 'pwa-title', text: T.title }),
        h('button', { class: 'pwa-btn', type: 'button', text: T.refresh, onclick: loadList }),
        h('button', { class: 'pwa-btn pwa-btn--primary', type: 'button', text: T.newSession, onclick: function () { newSession(undefined).then(function (id) { if (id) location.hash = '#/s/' + id }) } }))
      var tabs = h('div', { class: 'pwa-tabs', role: 'tablist' },
        h('button', { class: 'pwa-tab', role: 'tab', type: 'button', 'aria-selected': state.tab === 'sessions', onclick: function () { state.tab = 'sessions'; render() } }, T.sessions),
        h('button', { class: 'pwa-tab', role: 'tab', type: 'button', 'aria-selected': state.tab === 'approvals', onclick: function () { state.tab = 'approvals'; render() } }, T.approvals, count ? h('span', { class: 'pwa-badge', text: String(count) }) : null))
      $main = h('main', { class: 'pwa-main' }, state.error ? h('div', { class: 'pwa-error', role: 'alert', text: state.error }) : null, state.share ? renderShare() : null, renderList())
      $status = h('div', { class: 'pwa-status', 'aria-live': 'polite' })
      children = [bar2, tabs, $main, $status]
    }
    var focused = document.activeElement && document.activeElement.tagName === 'TEXTAREA' && state.current
    var selStart = focused ? document.activeElement.selectionStart : null
    $app.replaceChildren.apply($app, children)
    if (focused) { var t = $app.querySelector('.pwa-composer textarea'); if (t) { t.focus(); try { t.setSelectionRange(selStart, selStart) } catch (e) { /* ignore */ } } }
    if ($main && state.current && (stickBottom || atBottom)) $main.scrollTop = $main.scrollHeight
    renderStatus()
  }

  // ── Routing and lifecycle ────────────────────────────────────────────────
  function route() {
    var m = /^#\/s\/([A-Za-z0-9_-]+)$/.exec(location.hash)
    if (m) { if (state.current !== m[1]) { closeStream('session'); openSession(m[1]) } }
    else if (state.current) { closeSession() }
  }
  function boot() {
    var params = new URLSearchParams(location.search)
    var shareId = params.get('share')
    if (shareId) {
      guard(fetch('/share?id=' + encodeURIComponent(shareId), { credentials: 'same-origin' }).then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json() })).then(function (v) {
        if (v && v.ok) { state.share = Object.assign({}, v.share, { mode: v.mode }); render() }
      })
      history.replaceState(null, '', '/m#/')
    }
    window.addEventListener('hashchange', route)
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'hidden') { muxClose() }
      else { mux.backoff = 500; muxConnect(); loadList(); if (state.current) { state.messages = []; state.cursorSeq = null; loadHistory(false) } }
    })
    window.addEventListener('online', function () { muxConnect(); loadList() })
    openStream('events', '$events', {}, eventsItem)
    render(); loadList().then(route)
  }
  boot()
})()
