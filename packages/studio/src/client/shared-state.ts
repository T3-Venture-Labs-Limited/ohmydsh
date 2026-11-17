/**
 * State shared between the boot bundle (client.js) and the lazy workbench chunk (client.workbench.js).
 * The module loader only supports self-contained chunks, so modules imported by both are duplicated at build time.
 * Anything that must stay a singleton (the studio bus) lives on globalThis under a versioned key.
 */
const ROOT = '__dshStudioShared_v1'

export function sharedState<T>(key: string, create: () => T): T {
  const bag = ((globalThis as Record<string, unknown>)[ROOT] ??= {}) as Record<string, unknown>
  return (bag[key] ??= create()) as T
}
