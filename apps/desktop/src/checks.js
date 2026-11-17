'use strict'
// The checks behind `--headless-test` (window-less boot inside Electron, run on CI under xvfb) and `smoke.js` (the same
// checks with Electron acting as plain Node, runnable on a machine with no display). Pure HTTP against the started DSH.

/** @returns {Promise<{ ok: boolean, results: { name: string, ok: boolean, detail: string }[] }>} */
async function runChecks(url) {
  const origin = new URL(url).origin
  const results = []
  const check = async (name, fn) => {
    try { results.push({ name, ok: true, detail: await fn() }) } catch (e) { results.push({ name, ok: false, detail: e.message }) }
  }
  const jar = {}
  await check('token URL signs the app in (303 + HttpOnly cookie)', async () => {
    const r = await fetch(url, { redirect: 'manual' })
    const cookie = r.headers.get('set-cookie') ?? ''
    if (r.status !== 303 || !/HttpOnly/i.test(cookie)) throw new Error(`status ${r.status}`)
    jar.cookie = cookie.split(';')[0]
    return `${r.status}, cookie ${cookie.split('=')[0].slice(0, 12)}…`
  })
  await check('the DSH web UI loads with that cookie', async () => {
    const r = await fetch(`${origin}/`, { headers: { cookie: jar.cookie } })
    const body = await r.text()
    if (r.status !== 200 || !/<html/i.test(body)) throw new Error(`status ${r.status}`)
    return `200, ${body.length} bytes of HTML`
  })
  await check('without the cookie DSH answers 401', async () => {
    const r = await fetch(`${origin}/`)
    if (r.status !== 401) throw new Error(`status ${r.status}`)
    return '401'
  })
  await check('the phone-app plugin is active (/manifest.webmanifest)', async () => {
    const m = await (await fetch(`${origin}/manifest.webmanifest`)).json()
    if (m.start_url !== '/app') throw new Error(`start_url ${m.start_url}`)
    return `start_url ${m.start_url}`
  })
  await check('pairing routes are protected (/pair/code needs a sign-in)', async () => {
    const r = await fetch(`${origin}/pair/code`, { method: 'POST', headers: { 'content-type': 'application/json', origin }, body: '{}' })
    if (r.status !== 401) throw new Error(`status ${r.status}`)
    return '401'
  })
  await check('phone pairing works end to end on this DSH', async () => {
    const h = { cookie: jar.cookie, 'content-type': 'application/json', origin }
    const made = await (await fetch(`${origin}/pair/code`, { method: 'POST', headers: h, body: '{}' })).json()
    const code = new URL(made.links.app).searchParams.get('c')
    const claim = await (await fetch(`${origin}/pair/claim`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code, deviceName: 'smoke test' }) })).json()
    const session = await fetch(`${origin}/pair/session`, { headers: { authorization: `Bearer ${claim.token}` }, redirect: 'manual' })
    if (session.status !== 303 || !/dsh-auth-/.test(session.headers.get('set-cookie') ?? '')) throw new Error(`session ${session.status}`)
    await fetch(`${origin}/pair/remove`, { method: 'POST', headers: h, body: JSON.stringify({ id: claim.device.id }) })
    const revoked = await fetch(`${origin}/pair/session`, { headers: { authorization: `Bearer ${claim.token}` } })
    if (revoked.status !== 401) throw new Error(`after removal ${revoked.status}`)
    return 'code -> device token -> session cookie -> removed -> 401'
  })
  return { ok: results.every((r) => r.ok), results }
}

function report(results, header) {
  const lines = [header]
  for (const r of results) lines.push(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? ` – ${r.detail}` : ''}`)
  return lines.join('\n')
}

module.exports = { runChecks, report }
