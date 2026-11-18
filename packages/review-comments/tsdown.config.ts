// Builds both halves: lib/index.js (Host, ESM) and lib/client.js (browser closure factory for the module loader).
import { readFile } from 'node:fs/promises'
import { relative, resolve } from 'node:path'
import type { UserConfig } from 'tsdown'

const CLIENT_EXTERNALS = ['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client']
const PREFIX = '\0drc-css:'

/** `*.css?inline` becomes a string module (the kit and our own styles inject it while mounted). */
const inlineCss = {
  name: 'drc-inline-css',
  resolveId(source: string, importer?: string) {
    if (!source.endsWith('.css?inline')) return null
    const base = source.slice(0, -'?inline'.length)
    const abs = new URL(base, importer === undefined ? import.meta.url : `file://${importer}`).pathname
    // Relative to the package: the virtual id is echoed into the bundle as a `//#region` comment, and an absolute path
    // there would publish the build machine's directory layout.
    return `${PREFIX}${relative(process.cwd(), abs)}.mjs`
  },
  async load(this: { addWatchFile(file: string): void }, id: string) {
    if (!id.startsWith(PREFIX)) return null
    const file = resolve(process.cwd(), id.slice(PREFIX.length, -'.mjs'.length))
    this.addWatchFile(file)
    return `export default ${JSON.stringify(await readFile(file, 'utf8'))};`
  },
}

/** A platform package must never be a value import in the client bundle. */
const purityGate = {
  name: 'drc-purity',
  resolveId(source: string) {
    if (source.startsWith('@deepseek-ai/')) throw new Error(`client bundle purity: "${source}" is a platform package; collaborate through injected services`)
    return null
  },
}

const host: UserConfig = {
  name: '@t3labs/ohmydsh-review-comments',
  entry: { index: 'src/index.ts' },
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: true,
  // Host deps resolve from the real install; only @deepseek-ai/* and node builtins stay imports.
  deps: { neverBundle: [/^@deepseek-ai\//] },
}

const client: UserConfig = {
  name: '@t3labs/ohmydsh-review-comments/client',
  entry: { client: 'src/client/index.tsx' },
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  dts: false,
  sourcemap: true,
  clean: false,
  external: CLIENT_EXTERNALS,
  noExternal: (id: string) => (CLIENT_EXTERNALS.includes(id) ? undefined : true),
  define: { 'process.env.NODE_ENV': JSON.stringify('production') },
  plugins: [purityGate, inlineCss],
  outputOptions: {
    entryFileNames: 'client.js',
    banner: 'window.__ModuleLoader__.load({ id: "@t3labs/ohmydsh-review-comments", factory: (require) => {',
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
}

export default [host, client]
