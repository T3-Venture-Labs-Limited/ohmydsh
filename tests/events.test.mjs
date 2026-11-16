// Host half: /abx/events pushes state only on change, and nothing polls while idle.
// Runs the real apply() against a fake Cordis context; no third-party packages.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { apply } from '../index.js'

function makeCtx() {
  const routes = new Map()
  const tools = new Map()
  const effects = []
  const scoped = {
    webServer: {
      getOrigin: () => 'http://127.0.0.1:1',
      register: (route) => { routes.set(route.path, route.handler); return () => routes.delete(route.path) },
    },
    connection: { requestRejection: () => undefined },
    effect(fn) { effects.push(fn()) },
  }
  const ctx = {
    on() {},
    effect(fn) { effects.push(fn()) },
    inject(_names, fn) { fn(scoped) },
    tools: { guard: () => () => {}, register: (tool) => { tools.set(tool.name, tool); return () => tools.delete(tool.name) } },
    systemPrompt: { section: () => () => {} },
  }
  return { ctx, routes, tools, dispose: () => effects.forEach((d) => typeof d === 'function' && d()) }
}

function fakeRes() {
  const res = new EventEmitter()
  res.chunks = []
  res.status = 0
  res.writeHead = (status) => { res.status = status; return res }
  res.write = (chunk) => { res.chunks.push(String(chunk)); return true }
  res.end = (chunk) => { if (chunk) res.chunks.push(String(chunk)); res.ended = true }
  return res
}
const req = (path, method = 'GET') => ({ url: path, method, headers: { host: '127.0.0.1' } })
const frames = (res) => res.chunks.join('').split('\n\n').filter((f) => f.includes('event: state')).map((f) => JSON.parse(f.split('data: ')[1]))

// reconcile() fetches /browser/sessions; count requests and let tests set the answer.
let fetchCount = 0
let sessionRows = []
globalThis.fetch = async (url) => {
  const u = String(url)
  if (u.endsWith('/browser/sessions')) { fetchCount += 1; return { ok: true, json: async () => ({ sessions: sessionRows }) } }
  return { ok: true, json: async () => ({}) } // /browser/takeover
}

test('opens an SSE stream whose first frame is the full state, and registers /abx/state too', async () => {
  const { ctx, routes, dispose } = makeCtx()
  apply(ctx, { humanIdleMinutes: 10 })
  assert.ok(routes.has('/abx/events') && routes.has('/abx/state') && routes.has('/abx/control'))
  const res = fakeRes()
  await routes.get('/abx/events')(req('/abx/events'), res)
  assert.equal(res.status, 200)
  const [first] = frames(res)
  assert.deepEqual(first.leases, [])
  assert.equal(first.humanIdleMinutes, 10)
  res.emit('close')
  dispose()
})

test('pushes a frame on take and on release, and none when nothing changed', async () => {
  const { ctx, routes, dispose } = makeCtx()
  apply(ctx, { saveLoginsOnHandback: false })
  const res = fakeRes()
  await routes.get('/abx/events')(req('/abx/events'), res)
  await new Promise((r) => setTimeout(r, 20)) // the wake() reconcile settles
  const baseline = frames(res).length

  // readBody iterates the request as an async iterable
  const asyncReq = (body) => ({ ...req('/abx/control', 'POST'), async *[Symbol.asyncIterator]() { yield JSON.stringify(body) } })
  const call = (body) => new Promise((resolve) => {
    const r = fakeRes(); r.end = (c) => resolve(JSON.parse(c))
    routes.get('/abx/control')(asyncReq(body), r)
  })

  sessionRows = [{ name: 'c-1', takeover: true }]
  const took = await call({ session: 'c-1', action: 'take' })
  assert.equal(took.ok, true)
  assert.ok(frames(res).length > baseline, 'take pushes a frame')
  assert.equal(frames(res).at(-1).leases[0].owner, 'human')

  const before = frames(res).length
  const released = await call({ session: 'c-1', action: 'release' })
  assert.equal(released.ok, true)
  assert.ok(frames(res).length > before, 'release pushes a frame')
  assert.equal(frames(res).at(-1).leases[0].owner, 'agent')
  res.emit('close')
  dispose()
})

test('makes no /browser/sessions request while nobody is subscribed and nobody is driving', async () => {
  const { ctx, routes, dispose } = makeCtx()
  apply(ctx, {})
  fetchCount = 0
  await new Promise((r) => setTimeout(r, 2500)) // the old code fetched every 2 s regardless
  assert.equal(fetchCount, 0)
  const res = fakeRes()
  await routes.get('/abx/events')(req('/abx/events'), res)
  await new Promise((r) => setTimeout(r, 30))
  assert.equal(fetchCount, 1, 'a new subscriber triggers exactly one reconcile')
  res.emit('close')
  dispose()
})

test('unchanged state is not re-sent', async () => {
  const { ctx, routes, dispose } = makeCtx()
  apply(ctx, {})
  sessionRows = [{ name: 'c-2', takeover: false }]
  const res = fakeRes()
  await routes.get('/abx/events')(req('/abx/events'), res)
  await new Promise((r) => setTimeout(r, 30))
  const n = frames(res).length
  const second = fakeRes()
  await routes.get('/abx/events')(req('/abx/events'), second) // another subscriber -> reconcile, same data
  await new Promise((r) => setTimeout(r, 30))
  assert.equal(frames(res).length, n, 'identical payload is deduplicated')
  res.emit('close'); second.emit('close')
  dispose()
})
