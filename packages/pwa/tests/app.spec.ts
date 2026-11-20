// @vitest-environment node
// /app: the launch page of the installed app. The browser script is evaluated against a fake DOM, location and fetch.
import { describe, expect, it } from 'vitest'
import { appPageHtml, appScriptSource, APP_CSP } from '../src/host/app-page.ts'

const TOKEN = 'AbCdEfGh01234567_-xyzAbCdEfGh01234567'

interface Run { replaced: string[]; fetched: { url: string; init?: RequestInit }[]; el: Record<string, any>; submit(value: string): void; settle(): Promise<void>; storageTouched: string[] } // eslint-disable-line

async function boot(search: string, answers: { probe?: number | 'throw'; signInFlips?: boolean; cache?: Record<string, unknown> } = {}): Promise<Run> {
  const replaced: string[] = []
  const fetched: { url: string; init?: RequestInit }[] = []
  const storageTouched: string[] = []
  const el: Record<string, any> = {} // eslint-disable-line
  const element = (id: string) => (el[id] ??= { id, hidden: false, textContent: '', value: '', focus() {}, listeners: {} as Record<string, (e: unknown) => void>, addEventListener(t: string, f: (e: unknown) => void) { this.listeners[t] = f } })
  let signedInNow = false
  const fakeFetch = async (url: string, init?: RequestInit) => {
    fetched.push({ url, ...(init === undefined ? {} : { init }) })
    if (url.startsWith('/?token=')) signedInNow = true
    if (url === '/push/key') {
      const status = answers.signInFlips === true && signedInNow ? 200 : (answers.probe ?? 200)
      if (status === 'throw') throw new TypeError('offline')
      return new Response('{}', { status })
    }
    if (url === '/share') return new Response(JSON.stringify({ ok: true, id: 'a'.repeat(24) }), { status: 200 })
    return new Response('ok', { status: 200 })
  }
  const store = new Map<string, Response>(Object.entries(answers.cache ?? {}).map(([k, v]) => [k.replace(/^https?:\/\/[^/]+/, ''), v as Response]))
  const fakeCaches = { open: async () => ({
    match: async (k: string) => store.get(k)?.clone(),
    keys: async () => [...store.keys()].map((url) => ({ url })),
    delete: async (k: { url: string }) => store.delete(k.url),
  }) }
  const trap = (name: string) => new Proxy({}, { get: () => { storageTouched.push(name); return undefined }, set: () => { storageTouched.push(name); return true } })
  const location = { search, replace: (u: string) => { replaced.push(u) } }
  new Function('document', 'location', 'fetch', 'caches', 'FormData', 'URL', 'URLSearchParams', 'localStorage', 'sessionStorage', 'indexedDB', 'console', appScriptSource())(
    { getElementById: element }, location, fakeFetch, fakeCaches, FormData, URL, URLSearchParams, trap('localStorage'), trap('sessionStorage'), trap('indexedDB'),
    { log: () => storageTouched.push('console'), info: () => storageTouched.push('console'), warn: () => storageTouched.push('console'), error: () => storageTouched.push('console') })
  const settle = async () => { for (let i = 0; i < 30; i += 1) await new Promise((r) => setTimeout(r, 0)) }
  await settle()
  return { replaced, fetched, el, storageTouched, settle, submit(value: string) { el['link'].value = value; el['login'].listeners['submit']({ preventDefault() {} }) } }
}

describe('/app page markup', () => {
  const html = appPageHtml()
  it('has no inline script, no external resource, no storage, and the requested copy', () => {
    expect(html).toContain('<script src="/app.js"></script>')
    expect(html.replace(/<script src="\/app\.js"><\/script>/, '')).not.toMatch(/<script/i)
    expect(html).not.toMatch(/https?:\/\//i)
    expect(html).not.toMatch(/\son\w+=/i)
    expect(html).toContain('Paste your ohmydsh login link'); expect(html).toContain('>Sign in</button>')
    expect(html).toContain('color-scheme')
  })
  it('contains no secret or token value, and the CSP blocks everything but the own script and one inline style', () => {
    expect(html).not.toMatch(/token=[A-Za-z0-9_-]{8,}/)
    expect(appScriptSource()).not.toMatch(/[A-Za-z0-9_-]{40,}/)
    expect(APP_CSP).toMatch(/default-src 'none'.*script-src 'self'.*style-src 'sha256-/)
  })
})

describe('/app.js signed in', () => {
  it('probes /push/key with same-origin credentials and goes to / when signed in', async () => {
    const r = await boot('')
    expect(r.fetched[0]).toMatchObject({ url: '/push/key', init: { credentials: 'same-origin' } })
    expect(r.replaced).toEqual(['/'])
  })
  it('passes openSession and share through, and only those, only when valid', async () => {
    expect((await boot('?openSession=abc-123_X&share=0123456789abcdef01234567&evil=1&token=zzzz')).replaced).toEqual(['/?openSession=abc-123_X&share=0123456789abcdef01234567'])
    expect((await boot('?openSession=' + 'a'.repeat(128))).replaced).toEqual(['/?openSession=' + 'a'.repeat(128)])
    for (const bad of ['?openSession=' + 'a'.repeat(129), '?openSession=a/b', '?openSession=a%0d%0ab', '?openSession=%3Cscript%3E', '?openSession=', '?share=../x', '?openSession=a&share=b%20c']) {
      const out = (await boot(bad)).replaced[0] as string
      expect(out, bad).not.toMatch(/[<>]|\.\.|%0|\/x/)
      expect(out.startsWith('/'), bad).toBe(true)
    }
    expect((await boot('?openSession=a/b')).replaced).toEqual(['/'])
    expect((await boot('?openSession=a&share=b%20c')).replaced).toEqual(['/?openSession=a'])
  })
  it('shows the form on 401 and a connection message when the host is unreachable', async () => {
    const out = await boot('?openSession=abc', { probe: 401 })
    expect(out.replaced).toEqual([]); expect(out.el['login'].hidden).toBe(false); expect(out.el['title'].textContent).toBe('Sign in to ohmydsh')
    expect(out.el['message'].textContent).toBe('Get the link from the computer running ohmydsh.')
    const down = await boot('', { probe: 'throw' })
    expect(down.replaced).toEqual([]); expect(down.el['title'].textContent).toBe('Cannot reach ohmydsh'); expect(down.el['login'].hidden).toBe(true)
  })
})

describe('/app.js paste-link sign-in', () => {
  it('accepts a full link or a bare token and navigates same-origin to /?token=', async () => {
    for (const input of [`http://127.0.0.1:3090/?token=${TOKEN}`, `  https://dsh.example/some/path?x=1&token=${TOKEN}#h  `, TOKEN, ` ${TOKEN}\n`]) {
      const r = await boot('', { probe: 401 })
      r.submit(input)
      expect(r.replaced, input).toEqual([`/?token=${TOKEN}`])
    }
  })
  it('rejects bad tokens and non-links without navigating', async () => {
    const bad = ['', 'short', 'a'.repeat(15), 'a'.repeat(257), `${TOKEN}!`, `${TOKEN}&x=1`, 'http://x/?token=short', 'http://x/?nothing=1', 'http://x/?token=' + 'a'.repeat(300), 'javascript:alert(1)', `${TOKEN} ${TOKEN}`, `http://x/?token=${TOKEN}%0d%0a`]
    for (const input of bad) {
      const r = await boot('', { probe: 401 })
      r.submit(input)
      expect(r.replaced, JSON.stringify(input)).toEqual([])
      expect(r.el['error'].textContent, JSON.stringify(input)).toMatch(/not a ohmydsh login link/)
    }
    const r = await boot('', { probe: 401 })
    r.submit(`x=${TOKEN}`); expect(r.replaced).toEqual([])
  })
  it('never stores, caches or logs the token', async () => {
    const r = await boot('', { probe: 401 })
    r.submit(TOKEN)
    expect(r.storageTouched).toEqual([])
    expect(appScriptSource()).not.toMatch(/localStorage|sessionStorage|indexedDB|cookie|console\.|caches\.put|\.put\(/)
  })
  it('with a pending session or share it signs in by fetch, then reloads /app with the same query', async () => {
    const r = await boot('?openSession=abc', { probe: 401, signInFlips: true })
    r.submit(TOKEN); await r.settle()
    expect(r.fetched.map((f) => f.url)).toContain(`/?token=${TOKEN}`)
    expect(r.replaced).toEqual(['/app?openSession=abc'])
  })
})

describe('/app.js share hand-over', () => {
  const meta = { at: Date.now(), title: 'T', text: 'hello', url: '', files: [{ name: 'a.txt', type: 'text/plain', size: 3 }] }
  const base = 'http://127.0.0.1:3090/__dsh-share/' + 'b'.repeat(24) + '/'
  const cache = () => ({ [base + 'meta']: new Response(JSON.stringify(meta)), [base + 'file/0']: new Response('abc') })
  it('posts the stashed share to /share as JSON-asking same-origin fetch, deletes it, and opens /?share=<id>', async () => {
    const r = await boot('?shareLocal=' + 'b'.repeat(24), { cache: cache() })
    const post = r.fetched.find((f) => f.url === '/share')!
    expect(post.init).toMatchObject({ method: 'POST', credentials: 'same-origin', headers: { accept: 'application/json' } })
    const form = post.init!.body as FormData
    expect(form.get('text')).toBe('hello'); expect((form.get('files') as File).name).toBe('a.txt')
    expect(r.replaced).toEqual(['/?share=' + 'a'.repeat(24)])
  })
  it('an unknown or malformed local id never posts', async () => {
    expect((await boot('?shareLocal=' + 'c'.repeat(24), { cache: cache() })).replaced).toEqual(['/'])
    const bad = await boot('?shareLocal=../../x', { cache: cache() })
    expect(bad.fetched.some((f) => f.url === '/share')).toBe(false); expect(bad.replaced).toEqual(['/'])
    const err = await boot('?shareError=1')
    expect(err.replaced).toEqual([]); expect(err.el['title'].textContent).toMatch(/Could not share/)
  })
})

describe('product name is configurable', () => {
  const stock = { name: 'DeepSeek Harness', shortName: 'DSH' }
  it('the pages and scripts take the name from the product, escaped', () => {
    const html = appPageHtml(stock)
    expect(html).toContain('<title>DeepSeek Harness</title>'); expect(html).toContain('Paste your DeepSeek Harness login link')
    expect(appScriptSource(stock)).toContain('var PRODUCT = "DeepSeek Harness"')
    expect(appPageHtml({ name: '<b>x</b>', shortName: 'x' })).not.toContain('<b>x</b>')
    expect(appScriptSource({ name: '</script>', shortName: 'x' })).not.toContain('</script>')
  })
})
