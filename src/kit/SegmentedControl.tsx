// SegmentedControl: a tablist of equal-width segments with one sliding indicator (WAI-ARIA tabs keyboard model).
import { useEffect, useRef } from 'react'
import type { CSSProperties, KeyboardEvent } from 'react'
import { cx } from './cx.ts'

export interface SegmentedControlOption<Value extends string> {
  value: Value
  label: string
  disabled?: boolean
  title?: string
}

type WalkKey = 'ArrowLeft' | 'ArrowRight' | 'ArrowUp' | 'ArrowDown' | 'Home' | 'End'

function isWalkKey(key: string): key is WalkKey {
  return key === 'ArrowLeft' || key === 'ArrowRight' || key === 'ArrowUp' || key === 'ArrowDown' || key === 'Home' || key === 'End'
}

/** Next enabled option for a walk key: arrows wrap, Home/End jump to the first/last enabled. */
export function walk<Value extends string>(
  options: readonly SegmentedControlOption<Value>[],
  from: number,
  key: WalkKey,
): SegmentedControlOption<Value> | undefined {
  const enabled = options.filter((option) => option.disabled !== true)
  if (key === 'Home') return enabled[0]
  if (key === 'End') return enabled[enabled.length - 1]
  const step = key === 'ArrowRight' || key === 'ArrowDown' ? 1 : -1
  const count = options.length
  for (let offset = 1; offset < count; offset += 1) {
    const candidate = options[(((from + step * offset) % count) + count) % count]
    if (candidate !== undefined && candidate.disabled !== true) return candidate
  }
  return undefined
}

export interface SegmentedControlProps<Value extends string> {
  /** Base id: each tab is `<id>-<value>` and controls `<id>-<value>-panel`. */
  id: string
  value: Value
  options: readonly SegmentedControlOption<Value>[]
  onChange: (next: Value) => void
  /** Accessible name of the tablist. */
  label: string
  disabled?: boolean
  className?: string | undefined
}

/** Controlled segmented control; `onChange` never fires with the value already selected. */
export function SegmentedControl<Value extends string>({
  id, value, options, onChange, label, disabled = false, className,
}: SegmentedControlProps<Value>) {
  const list = useRef<HTMLDivElement>(null)
  const selected = options.findIndex((option) => option.value === value)

  // Keep keyboard focus on the selected tab after a walk key changes the value.
  useEffect(() => {
    const root = list.current
    if (root === null || !root.contains(document.activeElement)) return
    root.querySelector<HTMLButtonElement>('[role="tab"][aria-selected="true"]')?.focus()
  }, [value])

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>): void => {
    if (!isWalkKey(event.key)) return
    event.preventDefault()
    const target = walk(options, selected, event.key)
    if (target !== undefined && target.value !== value) onChange(target.value)
  }

  const indicator = { '--dk-segment-count': String(options.length), '--dk-segment-index': String(Math.max(0, selected)) } as CSSProperties

  return (
    <div ref={list} role="tablist" aria-label={label} className={cx('dk-segmented', className)} style={indicator}>
      <span aria-hidden="true" className="dk-segmented__indicator" />
      {options.map((option) => {
        const active = option.value === value
        return (
          <button
            key={option.value}
            id={`${id}-${option.value}`}
            type="button"
            role="tab"
            aria-selected={active}
            aria-controls={`${id}-${option.value}-panel`}
            tabIndex={active ? 0 : -1}
            disabled={disabled || option.disabled === true}
            title={option.title}
            className="dk-segmented__tab"
            onClick={() => { if (!active) onChange(option.value) }}
            onKeyDown={onKeyDown}
          >
            {option.label}
          </button>
        )
      })}
    </div>
  )
}
