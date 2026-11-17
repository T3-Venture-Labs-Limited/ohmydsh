'use strict'
// `dsh web` announces itself with one stdout line: `dsh web: http://127.0.0.1:<port>/?token=<launch token>`.
// The app reads it, hands the URL straight to its own window and never shows or logs the token.

const LINE = /^dsh web: (https?:\/\/\S+)\s*$/

/** @returns {{ origin: string, url: string } | undefined} */
function parseAnnouncement(line) {
  const m = LINE.exec(line.trim())
  if (m === null) return undefined
  let url
  try { url = new URL(m[1]) } catch { return undefined }
  if (!/^(127\.0\.0\.1|localhost|\[::1\]|\d+\.\d+\.\d+\.\d+)$/.test(url.hostname) && !url.hostname.endsWith('.ts.net')) return undefined
  if (!url.searchParams.get('token')) return undefined
  return { origin: url.origin, url: url.href }
}

/** Replace launch tokens in any text before it reaches a log file. */
function redact(text) {
  return String(text).replace(/([?&]token=)[A-Za-z0-9_-]+/g, '$1<redacted>').replace(/dsh-dev_[A-Za-z0-9_-]+/g, 'dsh-dev_<redacted>')
}

module.exports = { parseAnnouncement, redact }
