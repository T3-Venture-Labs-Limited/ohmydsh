import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { bsHitOf, captureBetterSidebar, cmViewOf, identifyHost } from '../src/client/adapters/bettersidebar.ts'
import { runtime } from '../src/client/runtime.ts'
import type { Ctx } from '../src/client/host.ts'

const ADDRESS = 'dsh-resource://file/session/s1/review-fixtures/auth.ts'
const fakeCtx = (version?: string): Ctx => ({
  get: (name: string) => name === 'betterSidebar' ? (version === undefined ? undefined : { version })
    : name === 'sidebarRight' ? { openTabs: { getSnapshot: () => [{ sessionId: 's1', tabId: 't1', kind: 'file', contentId: ADDRESS }] } } : undefined,
} as unknown as Ctx)

function mountEditor(lines: string[], view = true): { content: HTMLElement; host: HTMLElement } {
  document.body.innerHTML = `<div data-sidebar-right-session="s1"><div data-sidebar-right-tab="t1"><div data-dsh-native-tab-host>
    <input type="text" value="review-fixtures/auth.ts">
    <div class="cm-editor"><div class="cm-gutters"><div>1</div></div><div class="cm-content" contenteditable="true">${lines.map(l => `<div class="cm-line">${l}</div>`).join('')}</div></div>
  </div></div></div>`
  const content = document.querySelector<HTMLElement>('.cm-content')!
  const docLines = lines
  if (view) {
    const offsets: number[] = []; let at = 0
    docLines.forEach(l => { offsets.push(at); at += l.length + 1 })
    const full = docLines.join('\n')
    ;(content as unknown as { cmTile: unknown }).cmTile = { root: { view: {
      state: { doc: { lines: docLines.length, sliceString: (a: number, b: number) => full.slice(a, b), lineAt: (pos: number) => ({ number: offsets.filter(o => o <= pos).length }) } },
      posAtDOM: (node: Node, offset = 0) => {
        const line = (node instanceof Element ? node : node.parentElement)!.closest('.cm-line')!
        const index = [...content.children].indexOf(line)
        return offsets[index]! + (node.nodeType === Node.TEXT_NODE ? offset : 0)
      },
    } } }
  }
  return { content, host: document.querySelector<HTMLElement>('[data-dsh-native-tab-host]')! }
}

function select(startNode: Node, so: number, endNode: Node, eo: number): Selection {
  const range = document.createRange(); range.setStart(startNode, so); range.setEnd(endNode, eo)
  const sel = window.getSelection()!; sel.removeAllRanges(); sel.addRange(range); return sel
}
const deps = { readSource: async () => null, findLines: () => null }

const memory = new Map<string, string>()
beforeEach(() => { vi.stubGlobal('localStorage', { getItem: (k: string) => memory.get(k) ?? null, setItem: (k: string, v: string) => { memory.set(k, v) }, removeItem: (k: string) => { memory.delete(k) }, clear: () => { memory.clear() } }) })
afterEach(() => { runtime.set(undefined); memory.clear(); vi.unstubAllGlobals() })

describe('better-sidebar adapter', () => {
  it('reads exact lines from the EditorView', () => {
    runtime.set(fakeCtx('0.32.1'))
    const { content } = mountEditor(['import { sign } from "./crypto"', '', 'const token = sign(user)', 'return token'])
    const a = content.children[2]!.firstChild!, b = content.children[3]!.firstChild!
    const cap = captureBetterSidebar(select(a, 6, b, 6), deps)!
    expect(cap.anchor).toEqual({ kind: 'lines', start: 3, end: 4, hint: 'exact' })
    expect(cap.quote).toBe('token = sign(user)\nreturn')
    expect(cap.target).toMatchObject({ kind: 'file', path: 'review-fixtures/auth.ts', renderer: 'bs-code', address: ADDRESS })
    expect(cap.resolveAnchor).toBeUndefined()
  })
  it('falls back to a quote-only anchor when the view is unreachable', () => {
    runtime.set(fakeCtx('0.32.1'))
    const { content } = mountEditor(['alpha', 'beta'], false)
    const cap = captureBetterSidebar(select(content.children[0]!.firstChild!, 1, content.children[1]!.firstChild!, 2), deps)!
    expect(cap.anchor).toMatchObject({ kind: 'lines', hint: 'none' })
    expect(cap.resolveAnchor).toBeTypeOf('function')
    expect(cap.quote.replace(/\s+/g, ' ')).toContain('lpha')
  })
  it('is a no-op when the flag is off', () => {
    runtime.set(fakeCtx('0.32.1')); localStorage.setItem('dsh-review-comments:better-sidebar', 'off')
    const { content } = mountEditor(['alpha'])
    expect(bsHitOf(content.firstElementChild!.firstChild!)).toBeNull()
  })
  it('is a no-op outside the verified version window', () => {
    runtime.set(fakeCtx('0.99.0'))
    const { content } = mountEditor(['alpha'])
    expect(bsHitOf(content.firstElementChild!.firstChild!)).toBeNull()
    runtime.set(fakeCtx('0.10.0'))
    expect(bsHitOf(content.firstElementChild!.firstChild!)).toBeNull()
  })
  it('is a no-op when the host marker is missing', () => {
    runtime.set(fakeCtx('0.32.1'))
    document.body.innerHTML = '<div class="cm-editor"><div class="cm-content"><div class="cm-line">x</div></div></div>'
    expect(bsHitOf(document.querySelector('.cm-line')!.firstChild!)).toBeNull()
  })
  it('does not capture tabs rendered by documentpreview', () => {
    runtime.set(fakeCtx('0.32.1'))
    const { host, content } = mountEditor(['alpha'])
    host.insertAdjacentHTML('beforeend', '<div data-document-preview></div>')
    expect(bsHitOf(content.firstElementChild!.firstChild!)).toBeNull()
  })
  it('identifies the file via the tab inventory, falling back to the header path', () => {
    runtime.set(fakeCtx('0.32.1'))
    const { host } = mountEditor(['x'])
    expect(identifyHost(host)).toMatchObject({ address: ADDRESS, path: 'review-fixtures/auth.ts' })
    runtime.set({ get: () => undefined } as unknown as Ctx)
    expect(identifyHost(host)?.path).toBe('review-fixtures/auth.ts')
  })
  it('finds the view through the older cmView shape', () => {
    const { content } = mountEditor(['x'], false)
    ;(content as unknown as { cmView: unknown }).cmView = { view: { posAtDOM: () => 0, state: { doc: { lineAt: () => ({ number: 1 }), sliceString: () => '', lines: 1 } } } }
    expect(cmViewOf(content.parentElement!)).not.toBeNull()
  })
})

describe('better-sidebar markdown preview', () => {
  const mountPreview = (): HTMLElement => {
    document.body.innerHTML = `<div data-sidebar-right-session="s1"><div data-sidebar-right-tab="t1"><div data-dsh-native-tab-host>
      <div><input type="text" value="review-fixtures/notes.md"><button>Preview</button><button>Edit</button></div>
      <div class="preview"><h2>Goals</h2><p>We want to <strong>reduce latency</strong> and improve the onboarding flow.</p></div>
    </div></div></div>`
    return document.querySelector<HTMLElement>('.preview')!
  }
  it('captures a selection that crosses inline markup', () => {
    runtime.set({ get: (n: string) => n === 'sidebarRight' ? { openTabs: { getSnapshot: () => [{ sessionId: 's1', tabId: 't1', kind: 'file', contentId: 'dsh-resource://file/session/s1/review-fixtures/notes.md' }] } } : undefined } as unknown as Ctx)
    const root = mountPreview()
    const strong = root.querySelector('strong')!.firstChild!
    const tail = root.querySelector('p')!.lastChild!
    const cap = captureBetterSidebar(select(strong, 7, tail, 12), deps)
    expect(cap).not.toBeNull()
    expect(cap!.target).toMatchObject({ renderer: 'bs-markdown', path: 'review-fixtures/notes.md' })
    expect(cap!.quote).toBe('latency and improve')
    expect(cap!.resolveAnchor).toBeTypeOf('function')
  })
  it('treats a selection outside a still-mounted (hidden) editor as preview', () => {
    runtime.set({ get: () => undefined } as unknown as Ctx) // header path input identifies notes.md
    const root = mountPreview()
    root.parentElement!.insertAdjacentHTML('beforeend', '<div class="cm-editor" hidden><div class="cm-content" contenteditable="true"><div class="cm-line">hidden</div></div></div>')
    const text = root.querySelector('p')!.firstChild!
    const cap = captureBetterSidebar(select(text, 3, text, 7), deps)
    expect(cap?.target).toMatchObject({ renderer: 'bs-markdown' })
  })
})
