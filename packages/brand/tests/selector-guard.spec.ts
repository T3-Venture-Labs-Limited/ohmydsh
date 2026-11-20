// @vitest-environment node
// Guards the three stock-DSH facts this plugin depends on, so a DSH update that changes them fails here (and in CI)
// instead of quietly showing DeepSeek branding again:
//   1. the slots we occupy are still declared by the devDependency packages (always checked);
//   2. the shell still writes `document.title` as `<session> — <product>` through the two names brandTitle knows
//      (checked against the dsh-client-ui-layout source/bundle when present);
//   3. the kernel boot splash still renders a leaf <div> whose text is "HARNESS" inside `[data-dsh-boot]`
//      (checked against the installed dsh-web-frontend bundle: set DSH_GUARD_FRONTEND=<dist/assets dir>, or it is
//      found next to the `dsh` binary on PATH; skipped, with a notice, when neither exists).
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { delimiter, dirname, join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { BOOT_SCRIPT } from '../src/shared/index-html.ts'

const require = createRequire(import.meta.url)
const pkgDir = (name: string): string => dirname(require.resolve(`${name}/package.json`))
const read = (path: string): string => readFileSync(path, 'utf8')

describe('stock slots this plugin occupies are still declared', () => {
  const declared: [string, string, string][] = [
    ['@deepseek-ai/dsh-client-ui-sidebar', 'sidebar.brand.mark', 'client.js'],
    ['@deepseek-ai/dsh-client-ui-sidebar', 'sidebar.brand.name', 'client.js'],
    ['@deepseek-ai/dsh-client-ui-conversation', 'conversation.hero.brand.mark', 'client.js'],
  ]
  it.each(declared)('%s declares %s', (pkg, slot, file) => {
    const text = read(join(pkgDir(pkg), 'lib', file))
    expect(text.includes(slot), `${pkg} no longer declares ${slot}`).toBe(true)
  })
  it('the sidebar still renders both brand slots from its brand row', () => {
    const text = read(join(pkgDir('@deepseek-ai/dsh-client-ui-sidebar'), 'lib', 'client.js'))
    expect(/sidebar\.brand\.name/.test(text) && /sidebar\.brand\.mark/.test(text)).toBe(true)
  })
})

function layoutBundle(): string | undefined {
  try {
    const dir = pkgDir('@deepseek-ai/dsh-client-ui-conversation')
    return dir
  } catch { return undefined }
}

describe('document title', () => {
  it('brandTitle knows both product names the shell can write', () => {
    // The shell composes `${title} — ${productTitle}`; productTitle is DSH_CLIENT_TITLE or the locale's brand.localBuild.
    const locale = read(join(pkgDir('@deepseek-ai/dsh-client-locale'), 'lib', 'client.js'))
    expect(locale.includes('DSH Local Build')).toBe(true)
    expect(layoutBundle()).toBeDefined()
  })
})

function frontendAssets(): string | undefined {
  const env = process.env['DSH_GUARD_FRONTEND']
  if (env !== undefined && env !== '') return existsSync(env) ? env : undefined
  for (const dir of (process.env['PATH'] ?? '').split(delimiter)) {
    if (dir === '' || !existsSync(join(dir, 'dsh'))) continue
    for (const root of [resolve(dir, '..'), resolve(dir, '..', '..'), resolve(dir, '..', 'lib', 'node_modules', '@deepseek-ai', 'dsh')]) {
      const mise = join(root, 'node_modules', '.mise')
      if (existsSync(mise)) {
        const web = readdirSync(mise).find((n) => n.startsWith('@deepseek-ai+dsh-web-frontend@'))
        const assets = web === undefined ? undefined : join(mise, web, 'node_modules', '@deepseek-ai', 'dsh-web-frontend', 'dist', 'assets')
        if (assets !== undefined && existsSync(assets)) return assets
      }
    }
  }
  return undefined
}

describe('boot splash', () => {
  const assets = frontendAssets()
  const run = assets === undefined ? it.skip : it
  if (assets === undefined) console.warn('selector-guard: no dsh-web-frontend found (set DSH_GUARD_FRONTEND=<dist/assets>); the boot-splash check was skipped')

  run('the installed web bundle still builds a [data-dsh-boot] page whose first card child says HARNESS', () => {
    const js = readdirSync(assets!).filter((f) => /^index-.*\.js$/.test(f)).map((f) => read(join(assets!, f))).join('\n')
    // Booleans, not toContain/toMatch on the text: a failure would otherwise print a megabyte of minified bundle.
    expect(js.includes('dshBoot'), 'the boot page no longer sets dataset.dshBoot').toBe(true)
    expect(/\.wordmark=[\w$]+\([\w$]+\.wordmark,"HARNESS"\)/.test(js), 'the boot splash no longer builds a leaf wordmark div reading HARNESS').toBe(true)
  })

  run('Settings > General still has the settings.general.item list the credit joins', () => {
    // dsh-client-ui-settings-general is a sibling package in the same DSH install (not a dev dependency of ours).
    const mise = resolve(assets!, '..', '..', '..', '..', '..', '..')
    const general = readdirSync(mise).find((n) => n.startsWith('@deepseek-ai+dsh-client-ui-settings-general@'))
    expect(general, 'dsh-client-ui-settings-general is not installed next to the web frontend').toBeDefined()
    const text = read(join(mise, general!, 'node_modules', '@deepseek-ai', 'dsh-client-ui-settings-general', 'lib', 'client.js'))
    expect(text.includes('settings.general.item'), 'Settings > General no longer has a settings.general.item slot').toBe(true)
  })

  it('our swap looks for exactly that text, once, and gives up after 20 s', () => {
    expect(BOOT_SCRIPT).toContain('"HARNESS"')
    expect(BOOT_SCRIPT).toContain('[data-dsh-boot]')
    expect(BOOT_SCRIPT).toContain('disconnect()')
    expect(BOOT_SCRIPT).toContain('20000')
  })
})
