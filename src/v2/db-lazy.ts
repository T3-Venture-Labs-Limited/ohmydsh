/** Opens the SQLite file on first use, so merely loading the plugin never creates files under the DSH home. */
import { StudioDb } from './assets/db.js'

export function lazyDb(path: string): StudioDb {
  let real: StudioDb | undefined
  const open = (): StudioDb => (real ??= new StudioDb(path))
  return new Proxy({} as StudioDb, {
    get(_target, prop) {
      if (prop === 'close') return () => { real?.close(); real = undefined }
      const value = Reflect.get(open(), prop) as unknown
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(open()) : value
    },
  })
}
