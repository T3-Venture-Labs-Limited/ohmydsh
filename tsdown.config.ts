// Builds both halves of a DSH plugin:
//   lib/index.js      Host half (ESM, node)
//   lib/client.js     browser half in the closure-factory format the module loader expects, plus lazy chunks
//                     lib/client.<name>.js emitted for every dynamic import() (the loader runs them via require.async)
// Mirrors the official client preset (deepseek-harness packages/client/tsdown.client.ts) for plain plugin packages.
import { readFileSync } from 'node:fs'
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
    {
      // A source `import()` becomes `require.async("./client.<name>.js")`, the loader's lazy chunk operation.
      name: 'plugin-client-async-chunk-require',
      renderChunk(code: string, chunk: { dynamicImports: string[] }, outputOptions: { format?: string }) {
        if (outputOptions.format !== 'cjs') return null
        let out = code
        for (const dynamicImport of chunk.dynamicImports) {
          const fileName = dynamicImport.startsWith('./') ? dynamicImport.slice(2) : dynamicImport
          if (!/^client\.[A-Za-z0-9][A-Za-z0-9._-]*\.js$/.test(fileName)) continue
          const escaped = `./${fileName}`.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
          const call = new RegExp(`Promise\\.resolve\\(\\)\\.then\\(\\(\\)\\s*=>\\s*require\\((['"])${escaped}\\1\\)\\)`, 'gu')
          if (!call.test(out)) throw new Error(`client build: dynamic chunk ./${fileName} has no generated import expression`)
          call.lastIndex = 0
          out = out.replace(call, `require.async(${JSON.stringify(`./${fileName}`)})`)
        }
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
  ],
  outputOptions: {
    entryFileNames: 'client.js',
    chunkFileNames: 'client.[name].js',
    sourcemapExcludeSources: false,
    banner: (chunk: { isEntry: boolean; fileName: string }) =>
      `window.__ModuleLoader__.load({ id: ${JSON.stringify(id)}, ${chunk.isEntry ? '' : `chunk: ${JSON.stringify(chunk.fileName)}, `}factory: (require) => {`,
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
}

export default defineConfig([host, client])
