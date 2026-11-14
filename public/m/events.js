/* /m: turns raw session events into the chat rows the phone page shows. No DOM, no network, so it is unit-tested in Node.
 *
 * Visibility rule (mirrors dsh-client-ui-chat): a `user/message` is the person's own message only when
 * `data.source.kind === 'user'` (ui-chat: `match.event.data.source.kind !== 'user'` => context, not a user row).
 * Every other source kind is host-injected context and is NOT a chat bubble: runtime-context, skill-catalog,
 * time-context, model-selection, retry, composio, schedule and notice sources, compaction checkpoints, and so on.
 * Rows shown: the person's messages, assistant text (reasoning is not shown), and each tool call collapsed to
 * "Used <tool>". Tool results, developer/system messages and everything else are hidden. */
'use strict'
;(function (root) {
  var TOOL_PREFIX = 'Used '

  function textOf(content) {
    return (content || []).filter(function (p) { return p && p.type === 'text' && p.text }).map(function (p) { return p.text }).join('\n').trim()
  }

  /** Whether a user/message event is authored by the person (and not injected by the host). */
  function isHumanUserMessage(event) {
    var data = event && event.data
    if (!event || event.type !== 'user/message' || !data) return false
    var source = data.source
    // A missing source is treated as injected: the host always stamps human input with kind "user".
    return !!source && source.kind === 'user'
  }

  /** Events -> rows [{ seq, role: 'user'|'assistant'|'tool', text }]. */
  function parseEvents(records) {
    var out = []
    ;(records || []).forEach(function (r) {
      var e = r && r.event ? r.event : r
      if (!e || !e.type) return
      var d = e.data || {}
      if (e.type === 'user/message') {
        if (!isHumanUserMessage(e)) return
        var t = textOf(d.content)
        if (t) out.push({ seq: e.seq, role: 'user', text: t })
      } else if (e.type === 'assistant/message') {
        var parts = (d.message && d.message.content) || []
        var text = textOf(parts)
        if (text) out.push({ seq: e.seq, role: 'assistant', text: text })
        parts.forEach(function (p, i) {
          if (p && p.type === 'tool-call' && p.name) out.push({ seq: e.seq + (i + 1) / 100, role: 'tool', text: TOOL_PREFIX + p.name })
        })
      }
    })
    return out
  }

  var api = { parseEvents: parseEvents, isHumanUserMessage: isHumanUserMessage, textOf: textOf }
  if (typeof module === 'object' && module.exports) module.exports = api
  else root.PwaEvents = api
})(typeof window !== 'undefined' ? window : globalThis)
