'use strict'
// One rotating log file in the app data folder. Tokens are redacted by the callers (token-url.redact) and again here.
const fs = require('node:fs')
const path = require('node:path')
const { redact } = require('./token-url')

const MAX_BYTES = 2 * 1024 * 1024

function createLogger(dir, name = 'ohmydsh.log') {
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, name)
  try {
    if (fs.statSync(file).size > MAX_BYTES) fs.renameSync(file, path.join(dir, `${name}.1`))
  } catch { /* no log yet */ }
  const stream = fs.createWriteStream(file, { flags: 'a', mode: 0o600 })
  const write = (line) => { stream.write(`${new Date().toISOString()} ${redact(line)}\n`) }
  return { file, write, close: () => stream.end() }
}

module.exports = { createLogger }
