// Typed English-only dictionary helper over ctx.locale. English is the single source of truth; the typed `t` keys
// come from the dictionary object, so a missing key is a compile error and a locale could be added later by
// registering more dictionaries under the same namespace.

/** The slice of ctx.locale a plugin client uses. Matches @deepseek-ai/dsh-client-locale's LocaleRuntime. */
export interface LocaleFace {
  register(ns: string, locale: string, dict: Record<string, string>): () => void
  bind(ns: string): (key: string, params?: Record<string, unknown>) => string
}

export type Translator<D extends Record<string, string>> = (key: keyof D & string, params?: Record<string, string | number>) => string

/**
 * Define a plugin's English dictionary once and get typed register/bind functions.
 * @param ns - locale namespace (use the package name).
 * @param en - the English dictionary; `{name}` placeholders are filled from `params`.
 */
export function defineLocale<const D extends Record<string, string>>(ns: string, en: D) {
  return {
    ns,
    en,
    /** Register inside `apply`: `ctx.effect(() => locale.register(ctx.locale), 'name: dictionary')`. */
    register(face: LocaleFace): () => void {
      return face.register(ns, 'en', en)
    },
    /** Typed translate function reading the active locale at call time. */
    bind(face: LocaleFace): Translator<D> {
      const raw = face.bind(ns)
      return (key, params) => raw(key, params)
    },
  }
}
