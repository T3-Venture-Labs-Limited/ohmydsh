/** Plugin configuration (the `ohmydsh-keys` patch row). Invalid values fall back to the default; never throws. */
export interface KeysConfig {
  /** Answer approval and question cards from the keyboard. `false` leaves the stock behaviour (nothing is registered). */
  readonly enabled: boolean
  /** Move focus to a new card when it appears so the keys work at once (never while you are typing). */
  readonly autoFocus: boolean
}

/** The host writes the settings row into the page under this global name; the client half reads it. */
export const GLOBAL_NAME = '__OHMYDSH_KEYS__'

export function readConfig(raw: unknown): KeysConfig {
  const cfg = (raw !== null && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  return { enabled: cfg['enabled'] !== false, autoFocus: cfg['autoFocus'] !== false }
}
