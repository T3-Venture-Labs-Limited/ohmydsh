// Builds both halves of a DSH plugin:
//   lib/index.js      Host half (ESM, node)
//   lib/client.js     browser half in the closure-factory format the module loader expects, plus lazy chunks
//                     lib/client.<name>.js emitted for every dynamic import() (the loader runs them via require.async)
// Mirrors the official client preset (deepseek-harness packages/client/tsdown.client.ts) for plain plugin packages.
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { stat, utimes } from 'node:fs/promises'
import { defineConfig } from 'tsdown'
import type { UserConfig } from 'tsdown'

const manifest = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as {
  name: string
  dsh?: { client?: { external?: string[] } }
}
const id = manifest.name

/** Modules the shell seeds into the browser module table: never bundle these (packages/client/web/src/platform.ts). */
const PLATFORM_MODULES = [
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis',
  'zod', '@tanstack/react-virtual',
  '@deepseek-ai/dsh-client-store', '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives', '@deepseek-ai/dsh-client-ui-dockkit',
]
const requested = new Set([...PLATFORM_MODULES, ...(manifest.dsh?.client?.external ?? [])])

/** Lazy chunks are separate self-contained builds: ./client.<name>.js (see LAZY_CHUNKS). */
const LAZY_CHUNK = /^\.\/client\.[a-z][a-z0-9-]*\.js$/

const CSS_PREFIX = '\0plugin-css-inline:'

const host: UserConfig = {
  name: `${id}/host`,
  entry: { index: 'src/index.ts' },
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
  // Host deps resolve from the real install; only @deepseek-ai/* and node builtins stay imports.
  deps: { neverBundle: [/^@deepseek-ai\//] },
}

const client: UserConfig = {
  name: `${id}/client`,
  entry: { client: 'src/client/index.tsx' },
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  target: 'es2024',
  dts: false,
  clean: false,
  sourcemap: true,
  minify: { compress: false, mangle: false },
  deps: {
    neverBundle: (specifier: string) => requested.has(specifier),
    // Anything the module table cannot answer must be inlined: a require() it cannot resolve throws at runtime.
    alwaysBundle: (specifier: string) => !requested.has(specifier),
  },
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    'import.meta.env.MODE': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    'import.meta.env': JSON.stringify({ MODE: process.env.NODE_ENV ?? 'production' }),
  },
  plugins: [
    {
      // The workbench loader's `import('./client.workbench.js')` stays external and becomes the loader's lazy chunk call.
      name: 'plugin-client-async-chunk-require',
      resolveId(source: string) {
        return LAZY_CHUNK.test(source) ? { id: source, external: true } : null
      },
      renderChunk(code: string, _chunk: unknown, outputOptions: { format?: string }) {
        if (outputOptions.format !== 'cjs') return null
        const call = /import\(\s*(?:\/\*[\s\S]*?\*\/\s*)*(['"`])(\.\/client\.[a-z][a-z0-9-]*\.js)\1\s*\)/gu
        const out = code.replace(call, (_all, _q, file: string) => `require.async(${JSON.stringify(file)})`)
        if (/import\(\s*(?:\/\*[\s\S]*?\*\/\s*)*['"`]\.\/client\.[a-z][a-z0-9-]*\.js['"`]/.test(out)) throw new Error('client build: a lazy chunk import was not rewritten to require.async')
        return out === code ? null : { code: out, map: null }
      },
      async writeBundle(outputOptions: { dir?: string | undefined }, bundle: Record<string, { type: string; isEntry?: boolean; fileName: string }>) {
        // The Host derives the bundle revision from client.js's mtime: stamp it after every chunk is written.
        const entry = Object.values(bundle).find((o) => o.type === 'chunk' && o.isEntry)
        if (entry === undefined || outputOptions.dir === undefined) return
        const path = resolve(outputOptions.dir, entry.fileName)
        const info = await stat(path)
        await utimes(path, info.atime, new Date(Math.max(Date.now(), info.mtimeMs + 1)))
      },
    },
    {
      // `import css from './x.css?inline'` -> the stylesheet text as a string (the kit injects it while mounted).
      name: 'plugin-css-inline',
      resolveId(source: string, importer: string | undefined) {
        if (!source.endsWith('.css?inline')) return null
        const file = importer === undefined ? source.slice(0, -'?inline'.length) : resolve(dirname(importer), source.slice(0, -'?inline'.length))
        return CSS_PREFIX + file + '.mjs'
      },
      load(virtualId: string) {
        if (!virtualId.startsWith(CSS_PREFIX)) return null
        const file = virtualId.slice(CSS_PREFIX.length, -'.mjs'.length)
        ;(this as unknown as { addWatchFile(file: string): void }).addWatchFile(file)
        const css = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\s+/g, ' ').trim()
        return `export default ${JSON.stringify(css)};`
      },
    },
  ],
  outputOptions: {
    entryFileNames: 'client.js',
    sourcemapExcludeSources: false,
    banner:
      `window.__ModuleLoader__.load({ id: ${JSON.stringify(id)}, factory: (require) => {`,
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
}

// Lazy chunks: each is its own self-contained build (the module loader cannot satisfy a synchronous require between
// client*.js outputs, so shared code is duplicated and shared state lives on globalThis, see src/client/shared-state.ts).
// The boot bundle reaches a chunk with `import('./client.<name>.js')`, which the plugin above rewrites to the loader's
// `require.async("./client.<name>.js")`. To add one: add a row here, and its loader module in src/client.
const LAZY_CHUNKS: Readonly<Record<string, string>> = {
  workbench: 'src/client/workbench/index.ts',
}

const lazy = (name: string, entry: string): UserConfig => ({
  ...client,
  name: `${id}/client-${name}`,
  entry: { [`client.${name}`]: entry },
  plugins: client.plugins!.filter((plugin) => (plugin as { name?: string }).name === 'plugin-css-inline'),
  outputOptions: {
    entryFileNames: `client.${name}.js`,
    sourcemapExcludeSources: false,
    banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(id)}, chunk: ${JSON.stringify(`client.${name}.js`)}, factory: (require) => {`,
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
})

export default defineConfig([host, client, ...Object.entries(LAZY_CHUNKS).filter(([, entry]) => existsSync(entry)).map(([name, entry]) => lazy(name, entry))])
