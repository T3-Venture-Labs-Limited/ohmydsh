// Small sRGB colour toolkit: parse, mix, alpha, WCAG contrast. Pure, no DOM.

export type Rgb = readonly [number, number, number]

const HEX = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i

/** True for `#rgb` / `#rrggbb`, the only colour syntax Omarchy palettes use. */
export function isHex(value: unknown): value is string {
  return typeof value === 'string' && HEX.test(value)
}

export function parseHex(value: string): Rgb {
  if (!isHex(value)) throw new TypeError(`not a hex colour: ${value}`)
  let h = value.slice(1)
  if (h.length === 3) h = h.split('').map((c) => c + c).join('')
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]
}

const clamp = (n: number): number => Math.max(0, Math.min(255, Math.round(n)))

export function toHex([r, g, b]: Rgb): string {
  return '#' + [r, g, b].map((n) => clamp(n).toString(16).padStart(2, '0')).join('')
}

/** `amount` of `b` blended into `a` (0 → a, 1 → b). Same arithmetic as Omarchy's `mix_color start end amount`. */
export function mix(a: string, b: string, amount: number): string {
  const t = Math.max(0, Math.min(1, amount))
  const x = parseHex(a)
  const y = parseHex(b)
  return toHex([x[0] * (1 - t) + y[0] * t, x[1] * (1 - t) + y[1] * t, x[2] * (1 - t) + y[2] * t])
}

/** `rgba(r, g, b, alpha)` of a hex colour. */
export function alpha(color: string, a: number): string {
  const [r, g, b] = parseHex(color)
  return `rgba(${r}, ${g}, ${b}, ${Math.round(Math.max(0, Math.min(1, a)) * 1000) / 1000})`
}

/** WCAG relative luminance, 0..1. */
export function luminance(color: string): number {
  const lin = parseHex(color).map((v) => {
    const s = v / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * (lin[0] ?? 0) + 0.7152 * (lin[1] ?? 0) + 0.0722 * (lin[2] ?? 0)
}

/** WCAG contrast ratio, 1..21. */
export function contrast(a: string, b: string): number {
  const la = luminance(a)
  const lb = luminance(b)
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

/**
 * Nudge `color` toward `toward` until it reaches `min` contrast against `against` (or is `toward`).
 * Used as a legibility guard for text colours Omarchy themes sometimes get wrong.
 */
export function ensureContrast(color: string, against: string, min: number, toward: string): string {
  if (contrast(color, against) >= min) return color
  for (let step = 1; step <= 10; step++) {
    const next = mix(color, toward, step / 10)
    if (contrast(next, against) >= min) return next
  }
  return toward
}

/** Black or white, whichever reads better on `color`. */
export function onColor(color: string, dark = '#000000', light = '#ffffff'): string { // artwork:ok
  return contrast(color, dark) >= contrast(color, light) ? dark : light
}
