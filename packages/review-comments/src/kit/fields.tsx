// TextField and Select: labelled single-line controls with hint/error text.
import { forwardRef, useId } from 'react'
import type { InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from 'react'
import { cx } from './cx.ts'
import { IconChevronDown } from './icons.tsx'

interface FieldChrome {
  /** Visible label; also the accessible name. */
  label: string
  hint?: string
  /** When set the control is marked invalid and the message is announced. */
  error?: string
  className?: string
}

export type TextFieldProps = FieldChrome & {
  /** Optional 16px leading icon. */
  icon?: ReactNode
} & Omit<InputHTMLAttributes<HTMLInputElement>, 'className'>

/** Text input with label, optional icon, hint and error. */
export const TextField = forwardRef<HTMLInputElement, TextFieldProps>(function TextField(
  { label, hint, error, icon, className, id, disabled, ...rest },
  ref,
) {
  const auto = useId()
  const inputId = id ?? auto
  const noteId = `${inputId}-note`
  const note = error ?? hint
  return (
    <div className={cx('dk-field', className)}>
      <label className="dk-field__label" htmlFor={inputId}>{label}</label>
      <span className="dk-input" data-invalid={error !== undefined || undefined} data-disabled={disabled === true || undefined}>
        {icon != null && <span className="dk-input__icon">{icon}</span>}
        <input
          ref={ref}
          id={inputId}
          className="dk-input__control"
          disabled={disabled}
          aria-invalid={error !== undefined || undefined}
          aria-describedby={note !== undefined ? noteId : undefined}
          {...rest}
        />
      </span>
      {note !== undefined && (
        <p id={noteId} className={error !== undefined ? 'dk-field__error' : 'dk-field__hint'} role={error !== undefined ? 'alert' : undefined}>{note}</p>
      )}
    </div>
  )
})

export interface SelectOption {
  value: string
  label: string
  disabled?: boolean
}

export type SelectProps = FieldChrome & {
  options: readonly SelectOption[]
  value: string
  onChange: (next: string) => void
} & Omit<SelectHTMLAttributes<HTMLSelectElement>, 'className' | 'value' | 'onChange' | 'children'>

/** Native `<select>` styled with tokens: keeps platform keyboard, mobile pickers and a11y for free. */
export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { label, hint, error, options, value, onChange, className, id, disabled, ...rest },
  ref,
) {
  const auto = useId()
  const selectId = id ?? auto
  const noteId = `${selectId}-note`
  const note = error ?? hint
  return (
    <div className={cx('dk-field', className)}>
      <label className="dk-field__label" htmlFor={selectId}>{label}</label>
      <span className="dk-input dk-select" data-invalid={error !== undefined || undefined} data-disabled={disabled === true || undefined}>
        <select
          ref={ref}
          id={selectId}
          className="dk-input__control"
          value={value}
          disabled={disabled}
          aria-invalid={error !== undefined || undefined}
          aria-describedby={note !== undefined ? noteId : undefined}
          onChange={(event) => { onChange(event.target.value) }}
          {...rest}
        >
          {options.map((option) => (
            <option key={option.value} value={option.value} disabled={option.disabled}>{option.label}</option>
          ))}
        </select>
        <span className="dk-select__chevron"><IconChevronDown size={14} /></span>
      </span>
      {note !== undefined && (
        <p id={noteId} className={error !== undefined ? 'dk-field__error' : 'dk-field__hint'} role={error !== undefined ? 'alert' : undefined}>{note}</p>
      )}
    </div>
  )
})
