// Button and IconButton. Variants map to --dsw-alias-button-* token families (see kit.css).
import { forwardRef } from 'react'
import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { cx } from './cx.ts'

export type ButtonVariant = 'primary' | 'ghost' | 'outline' | 'toolbar' | 'danger'

export type ButtonProps = {
  variant?: ButtonVariant
  size?: 'md' | 'sm'
  /** Optional leading 16px icon node. */
  icon?: ReactNode
  className?: string
  children?: ReactNode
} & ButtonHTMLAttributes<HTMLButtonElement>

/** Token-styled button. `type` defaults to "button" so it never submits a form by accident. */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'ghost', size = 'md', icon, className, children, ...rest },
  ref,
) {
  return (
    <button ref={ref} type="button" className={cx('dk-button', `dk-button--${variant}`, `dk-button--${size}`, className)} {...rest}>
      {icon != null && <span className="dk-button__icon">{icon}</span>}
      {children}
    </button>
  )
})

export type IconButtonProps = {
  /** Required accessible name: an icon-only control must never ship without one. */
  label: string
  icon: ReactNode
  size?: 'md' | 'sm'
  className?: string
} & Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'aria-label' | 'children'>

/** Square icon-only button; pass `aria-pressed` for a toggle. */
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, icon, size = 'sm', className, ...rest },
  ref,
) {
  return (
    <button ref={ref} type="button" aria-label={label} className={cx('dk-icon-button', size === 'md' && 'dk-icon-button--md', className)} {...rest}>
      {icon}
    </button>
  )
})
