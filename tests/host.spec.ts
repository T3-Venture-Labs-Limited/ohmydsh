// @vitest-environment node
import { mkdtemp, mkdir, rm, writeFile, rename } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { OmarchyState, readOmarchy } from '../src/host/omarchy-state.ts'
import { withAdmission } from '../src/host/routes.ts'

const toml = (bg: string, mode = 'dark') => `mode = "${mode}"\nbackground = "${bg}"\nforeground = "#cccccc"\naccent = "#ff8800"\n`

async function swapTheme(dir: string, name: string, bg: string, mode: string, gen: string) {
  // Omarchy: stage next-theme, rm -rf theme, mv, then write generation and name.
  const next = join(dir, 'next-theme')
  await mkdir(next, { recursive: true })
  await writeFile(join(next, 'colors.toml'), toml(bg, mode))
  await rm(join(dir, 'theme'), { recursive: true, force: true })
  await rename(next, join(dir, 'theme'))
  await writeFile(join(dir, 'theme.generation'), gen)
  await writeFile(join(dir, 'theme.name'), name)
}

describe('Omarchy state watcher', () => {
  it('reads the palette, and republishes after the theme dir is replaced', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-theme-'))
    try {
      await swapTheme(dir, 'one', '#101010', 'dark', 'g1')
      const state = new OmarchyState({ dir, debounceMs: 20, fallbackPollMs: 100000 })
      const seen: string[] = []
      state.subscribe((s) => { seen.push(`${s?.name}:${s?.generation}:${s?.mode}`) })
      const stop = await state.start()
      expect(state.current()?.name).toBe('one')
      await swapTheme(dir, 'two', '#fafafa', 'light', 'g2')
      await new Promise((r) => setTimeout(r, 400))
      expect(state.current()).toMatchObject({ name: 'two', generation: 'g2', mode: 'light' })
      expect(seen.at(-1)).toBe('two:g2:light')
      // no duplicate publishes for one swap burst
      expect(seen.filter((s) => s === 'two:g2:light')).toHaveLength(1)
      stop()
    } finally { await rm(dir, { recursive: true, force: true }) }
  })
  it('is unavailable when Omarchy state is absent', async () => {
    expect(await readOmarchy('/nonexistent/omarchy/current')).toBeUndefined()
  })
})

describe('route admission', () => {
  const run = (admission: Parameters<typeof withAdmission>[0]) => {
    let status = 0
    let ended = ''
    let handled = false
    const res = { writeHead: (s: number) => { status = s }, end: (b?: string) => { ended = b ?? '' } }
    withAdmission(admission, () => { handled = true })({} as never, res as never)
    return { status, ended, handled }
  }
  it('fails closed with no admission check', () => {
    expect(run(() => undefined)).toMatchObject({ status: 503, handled: false })
  })
  it('forwards 401/403 rejections', () => {
    expect(run(() => () => 401)).toMatchObject({ status: 401, handled: false })
    expect(run(() => () => 403)).toMatchObject({ status: 403, handled: false })
  })
  it('fails closed when the check throws, and admits when it returns undefined', () => {
    expect(run(() => () => { throw new Error('x') })).toMatchObject({ status: 503, handled: false })
    expect(run(() => () => undefined)).toMatchObject({ handled: true })
  })
})
