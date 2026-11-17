'use strict'
// Runs `dsh omd` as a child process, learns its URL from the one line it prints, restarts it if it dies, and stops it
// cleanly. Process spawning is injected so the restart policy is unit-tested without starting DSH.
const { EventEmitter } = require('node:events')
const { spawn } = require('node:child_process')
const { parseAnnouncement, redact } = require('./token-url')

const BACKOFF_MS = [1000, 2000, 5000, 10000, 30000]
const STABLE_MS = 60_000
const MAX_RESTARTS_IN_ROW = 8
const STOP_GRACE_MS = 8000

/**
 * @fires Supervisor#ready   ({ origin, url })  DSH printed its URL; `url` carries the launch token: give it to a window, never show it
 * @fires Supervisor#exit    ({ code, signal, willRestart })
 * @fires Supervisor#failed  (message)          too many crashes in a row
 */
class Supervisor extends EventEmitter {
  /**
   * @param {object} o
   * @param {string} o.electron  executable acting as Node
   * @param {string} o.dshBin    DSH CLI script
   * @param {string} o.profile   DSH profile to run ('omd')
   * @param {number} o.port
   * @param {string} o.host
   * @param {string[]} o.trustedHosts
   * @param {NodeJS.ProcessEnv} o.env
   * @param {(line: string) => void} o.log
   * @param {typeof spawn} [o.spawnImpl]
   * @param {(fn: () => void, ms: number) => unknown} [o.setTimer]
   * @param {() => number} [o.now]
   */
  constructor(o) {
    super()
    this.o = o
    this.spawn = o.spawnImpl ?? spawn
    this.setTimer = o.setTimer ?? ((fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return t })
    this.now = o.now ?? Date.now
    this.child = undefined
    this.stopping = false
    this.crashes = 0
    this.startedAt = 0
    this.current = undefined
    this.timer = undefined
  }

  args() {
    const { dshBin, profile, port, host, trustedHosts } = this.o
    const out = [dshBin, profile, '--no-open', '--port', String(port), '--host', host]
    for (const t of trustedHosts ?? []) out.push('--trusted-host', t)
    return out
  }

  start() {
    if (this.child !== undefined) return
    this.stopping = false
    this.current = undefined
    this.startedAt = this.now()
    const child = this.spawn(this.o.electron, this.args(), { env: this.o.env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    this.child = child
    let buffer = ''
    const onLine = (line) => {
      const announced = parseAnnouncement(line)
      if (announced !== undefined && this.current === undefined) {
        this.current = announced
        this.emit('ready', announced)
        return
      }
      this.o.log(redact(line))
    }
    const feed = (chunk) => {
      buffer += chunk.toString('utf8')
      let at
      while ((at = buffer.indexOf('\n')) !== -1) { onLine(buffer.slice(0, at).replace(/\r$/, '')); buffer = buffer.slice(at + 1) }
    }
    child.stdout.on('data', feed)
    child.stderr.on('data', (c) => { for (const l of c.toString('utf8').split(/\r?\n/)) if (l.trim() !== '') this.o.log(redact(l)) })
    child.on('error', (e) => { this.o.log(`could not start DSH: ${e.message}`) })
    child.on('close', (code, signal) => {
      if (this.child !== child) return
      this.child = undefined
      this.current = undefined
      if (this.stopping) { this.emit('exit', { code, signal, willRestart: false }); return }
      // A run that lasted a while resets the crash counter; quick repeated deaths back off and eventually give up.
      if (this.now() - this.startedAt > STABLE_MS) this.crashes = 0
      this.crashes += 1
      const give = this.crashes > MAX_RESTARTS_IN_ROW
      this.emit('exit', { code, signal, willRestart: !give })
      if (give) { this.emit('failed', `DSH stopped ${this.crashes} times in a row (last exit code ${code ?? signal}). See the log.`); return }
      const delay = BACKOFF_MS[Math.min(this.crashes - 1, BACKOFF_MS.length - 1)]
      this.timer = this.setTimer(() => { this.timer = undefined; if (!this.stopping) this.start() }, delay)
    })
  }

  /** Manual restart (tray). Also clears the crash counter. */
  restart() {
    this.crashes = 0
    return this.stop().then(() => { this.start() })
  }

  /** Ask DSH to stop (SIGTERM), then force it after a grace period. Resolves when the process is gone. */
  stop() {
    this.stopping = true
    if (this.timer !== undefined) { clearTimeout(this.timer); this.timer = undefined }
    const child = this.child
    if (child === undefined) return Promise.resolve()
    return new Promise((resolve) => {
      let done = false
      const finish = () => { if (!done) { done = true; resolve() } }
      child.once('close', finish)
      try { child.kill('SIGTERM') } catch { /* already gone */ }
      this.setTimer(() => { if (!done) { try { child.kill('SIGKILL') } catch { /* gone */ } finish() } }, STOP_GRACE_MS)
    })
  }

  get running() { return this.child !== undefined }
}

module.exports = { Supervisor, BACKOFF_MS, MAX_RESTARTS_IN_ROW }
