// Glass: how see-through the composer, the sidebar and the open right panel are. Independent of the look and of the colours.
//
//   setting    values                                      where
//   profile    auto | off | subtle | standard | strong     `glass:` on the dsh-theme row (default auto)
//   browser    default | off | subtle | standard | strong  Settings > Theme (default = follow the profile)
//
// `auto` is `standard` while the Endfield look is on (what the look has always drawn) and `off` otherwise, so nobody's
// appearance changes until they ask. An explicit value, profile or browser, always wins; the browser beats the profile.
export type Glass = 'off' | 'subtle' | 'standard' | 'strong'
export type GlassDefault = Glass | 'auto'
export type GlassChoice = Glass | 'default'

export const GLASSES: readonly Glass[] = ['off', 'subtle', 'standard', 'strong']
export const isGlass = (value: unknown): value is Glass => value === 'off' || value === 'subtle' || value === 'standard' || value === 'strong'
export const isGlassDefault = (value: unknown): value is GlassDefault => value === 'auto' || isGlass(value)

/** Parse the profile config value; anything unknown is `auto`. */
export const glassDefaultOf = (value: unknown): GlassDefault => isGlassDefault(value) ? value : 'auto'

/** The tier in effect. `endfieldLook`: the Endfield look is being drawn by this plugin (not by dsh-theme-endfield itself). */
export function resolveGlass(choice: GlassChoice, profile: GlassDefault, endfieldLook: boolean): Glass {
  if (choice !== 'default') return choice
  if (profile !== 'auto') return profile
  return endfieldLook ? 'standard' : 'off'
}
