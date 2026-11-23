// The look of the hints and badges: theme tokens only (tools/token-lint.mjs enforces it), so it follows light, dark and
// the theme plugin's looks. Nothing is inserted into DSH's tree: the hint is the ::after of the card, the badge is the
// ::before (approval buttons) or ::after (multi-choice options) of a button that carries `data-ohmydsh-key[-end]`.
export const STYLE_ID = 'ohmydsh-keys-style'

export const CSS = `
[data-ohmydsh-keys-hint]::after {
  content: attr(data-ohmydsh-keys-hint);
  display: block;
  box-sizing: border-box;
  padding: 6px 16px 0;
  font-size: 12px;
  line-height: 16px;
  text-align: center;
  color: var(--dsw-alias-label-tertiary);
  pointer-events: none;
}
/* The question frame is a flex row: stack the hint under the card instead of beside it. */
[data-question-key][data-ohmydsh-keys-hint] { flex-direction: column; align-items: center; }
[data-question-key][data-ohmydsh-keys-hint]::after { width: 100%; max-width: var(--dsh-chat-content-width); }
[data-ohmydsh-keys-hint]:focus-within::after { color: var(--dsw-alias-label-secondary); }
@media (prefers-reduced-motion: no-preference) {
  [data-ohmydsh-keys-hint]::after { transition: color 0.15s ease; }
}
[data-ohmydsh-key]::before,
[data-ohmydsh-key-end]::after {
  content: attr(data-ohmydsh-key) attr(data-ohmydsh-key-end);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  box-sizing: border-box;
  flex: none;
  min-width: 16px;
  height: 16px;
  padding: 0 4px;
  border: 1px solid currentColor;
  border-radius: 4px;
  font-size: 11px;
  font-weight: 600;
  line-height: 1;
  opacity: 0.7;
}
[data-ohmydsh-key]::before { margin-right: 6px; }
[data-ohmydsh-key-end]::after { margin-left: auto; align-self: center; }
@media (max-width: 599.98px) {
  [data-ohmydsh-keys-hint]::after { display: none; }
}
/* Touch devices: no hints and no badges (there is no keyboard to use them with). */
@media (hover: none) and (pointer: coarse) {
  [data-ohmydsh-keys-hint]::after,
  [data-ohmydsh-key]::before,
  [data-ohmydsh-key-end]::after { display: none; }
}
`

/** Mount the stylesheet; returns the disposer. */
export function mountStyle(doc: Document): () => void {
  const el = doc.createElement('style')
  el.id = STYLE_ID
  el.textContent = CSS
  doc.head.appendChild(el)
  return () => { el.remove() }
}
