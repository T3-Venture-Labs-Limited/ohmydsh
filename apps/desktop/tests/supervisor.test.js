'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { Supervisor, BACKOFF_MS, MAX_RESTARTS_IN_ROW } = require('../src/supervisor')

function fake() {
  const spawned = []
  const timers = []
  let clock = 0
  const spawnImpl = (file, args, opts) => {
    const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), killed: [], kill(sig) { this.killed.push(sig); if (sig === 'SIGTERM' && this.autoExit !== false) setImmediate(() => this.emit('close', 0, 'SIGTERM')) } })
    spawned.push({ file, args, opts, child })
    return child
  }
  const sup = new Supervisor({ electron: '/e', dshBin: '/dsh.js', profile: 'omd', port: 43080, host: '127.0.0.1', trustedHosts: ['x.ts.net'], env: { A: '1' }, log: (l) => sup.lines.push(l), spawnImpl, setTimer: (fn, ms) => { timers.push({ fn, ms }); return { unref() {} } }, now: () => clock })
  sup.lines = []
  return { sup, spawned, timers, tick: (ms) => { clock += ms } }
}

test('starts dsh omd on the fixed port with trusted hosts; reads the URL and never logs it', () => {
  const { sup, spawned } = fake(); let ready
  sup.on('ready', (r) => { ready = r }); sup.start()
  assert.deepEqual(spawned[0].args, ['/dsh.js', 'omd', '--no-open', '--port', '43080', '--host', '127.0.0.1', '--trusted-host', 'x.ts.net'])
  spawned[0].child.stdout.emit('data', Buffer.from('booting…\ndsh web: http://127.0.0.1:43080/?token=SECRETSECRETSECRETSECRET\n'))
  assert.equal(ready.origin, 'http://127.0.0.1:43080'); assert.match(ready.url, /SECRETSECRET/)
  assert.ok(sup.lines.every((l) => !l.includes('SECRETSECRET')) && sup.lines.includes('booting…'))
})
test('lines split across chunks are reassembled', () => {
  const { sup, spawned } = fake(); let n = 0; sup.on('ready', () => { n += 1 }); sup.start()
  spawned[0].child.stdout.emit('data', Buffer.from('dsh web: http://127.0.0.1:43080/?tok'))
  spawned[0].child.stdout.emit('data', Buffer.from('en=abcdefghijklmnop\n'))
  assert.equal(n, 1)
})
test('a crash restarts with back-off; a long stable run resets the counter; too many crashes give up', () => {
  const { sup, spawned, timers, tick } = fake(); const exits = []; let failed
  sup.on('exit', (e) => exits.push(e.willRestart)); sup.on('failed', (m) => { failed = m }); sup.start()
  spawned[0].child.emit('close', 1, null)
  assert.equal(timers.at(-1).ms, BACKOFF_MS[0]); timers.at(-1).fn(); assert.equal(spawned.length, 2)
  spawned[1].child.emit('close', 1, null); assert.equal(timers.at(-1).ms, BACKOFF_MS[1])
  timers.at(-1).fn(); tick(61_000); spawned[2].child.emit('close', 1, null)
  assert.equal(timers.at(-1).ms, BACKOFF_MS[0]) // stable run reset the counter
  for (let i = 0; i < MAX_RESTARTS_IN_ROW + 1 && failed === undefined; i += 1) { timers.at(-1)?.fn(); spawned.at(-1).child.emit('close', 1, null) }
  assert.match(failed, /stopped \d+ times in a row/); assert.equal(exits.at(-1), false)
})
test('stop sends SIGTERM, does not restart, force-kills after the grace period', async () => {
  const a = fake(); a.sup.start(); let restarted = false; a.sup.on('exit', (e) => { restarted = e.willRestart })
  await a.sup.stop(); assert.deepEqual(a.spawned[0].child.killed, ['SIGTERM']); assert.equal(restarted, false); assert.equal(a.timers.length, 1) // only the grace timer
  const b = fake(); b.sup.start(); b.spawned[0].child.autoExit = false
  const p = b.sup.stop(); b.timers.at(-1).fn(); await p
  assert.deepEqual(b.spawned[0].child.killed, ['SIGTERM', 'SIGKILL'])
})
test('restart stops, then starts a fresh process and clears the crash counter', async () => {
  const { sup, spawned } = fake(); sup.start(); sup.crashes = 5
  await sup.restart(); assert.equal(spawned.length, 2); assert.equal(sup.crashes, 0)
})
