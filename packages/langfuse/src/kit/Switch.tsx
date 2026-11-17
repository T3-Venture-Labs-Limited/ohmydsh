// Switch: two-state toggle. `label` has no default so a render site cannot ship it without an accessible name.
import { cx } from './cx.ts'

export interface SwitchProps {
  checked: boolean
  onChange: (next: boolean) => void
  /** Accessible name. */
  label: string
  disabled?: boolean
  /** Hover text, typically why the toggle is locked. */
  title?: string | undefined
  className?: string | undefined
}

/** Fully controlled switch; appearance keys off aria-checked so it cannot disagree with assistive technology. */
export function Switch({ checked, onChange, label, disabled = false, title, className }: SwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      title={title}
      disabled={disabled}
      className={cx('dk-switch', className)}
      onClick={() => { onChange(!checked) }}
    >
      <span className="dk-switch__thumb" />
    </button>
  )
}
