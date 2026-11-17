'use strict'
// User-editable settings (settings.json in the app data folder). Unknown or invalid values fall back to defaults.
const fs = require('node:fs')
const path = require('node:path')

const DEFAULTS = Object.freeze({
  // A stable port matters: a paired phone remembers http(s)://<computer>:<port>.
  port: 43080,
  // Loopback only by default. Reach the phone through Tailscale (`tailscale serve` proxies to this port).
  host: '127.0.0.1',
  trustedHosts: [],
  autoUpdate: true,
  startMinimized: false,
})

const HOST = /^(?:\d{1,3}(?:\.\d{1,3}){3}|\[?[0-9a-fA-F:]+\]?)$/
const AUTHORITY = /^[A-Za-z0-9.-]+(?::\d{1,5})?$/

function normalize(raw) {
  const o = raw !== null && typeof raw === 'object' ? raw : {}
  const port = Number.isInteger(o.port) && o.port >= 1024 && o.port <= 65535 ? o.port : DEFAULTS.port
  const host = typeof o.host === 'string' && HOST.test(o.host) && !/^(0\.0\.0\.0|::|\[::\])$/.test(o.host) ? o.host : DEFAULTS.host
  const trustedHosts = Array.isArray(o.trustedHosts) ? o.trustedHosts.filter((h) => typeof h === 'string' && AUTHORITY.test(h)).slice(0, 10) : []
  return {
    port, host, trustedHosts,
    autoUpdate: o.autoUpdate !== false,
    startMinimized: o.startMinimized === true,
  }
}

function loadSettings(file) {
  try { return normalize(JSON.parse(fs.readFileSync(file, 'utf8'))) } catch { return normalize({}) }
}

function saveSettings(file, settings) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `${JSON.stringify(normalize(settings), null, 2)}\n`, { mode: 0o600 })
}

module.exports = { DEFAULTS, normalize, loadSettings, saveSettings }
