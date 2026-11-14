/** Join class names, skipping falsy entries (a 5-line stand-in for `clsx`, so the kit has no runtime dependency). */
export function cx(...parts: readonly (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ')
}
