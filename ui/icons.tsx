// Small inline icons drawn with currentColor strokes, so they follow label tokens in light and dark themes.
import type { SVGProps } from 'react'

type IconProps = { size?: number } & Omit<SVGProps<SVGSVGElement>, 'width' | 'height' | 'viewBox'>

function Icon({ size = 16, children, ...rest }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {children}
    </svg>
  )
}

/** Cross used by the Modal close button. */
export function IconClose(props: IconProps) {
  return <Icon {...props}><path d="M4 4l8 8M12 4l-8 8" /></Icon>
}

/** Chevron used by Select. */
export function IconChevronDown(props: IconProps) {
  return <Icon {...props}><path d="M4 6l4 4 4-4" /></Icon>
}

/** Warning triangle for error/warn empty states. */
export function IconWarning(props: IconProps) {
  return <Icon {...props}><path d="M8 2.5l6 10.5H2L8 2.5zM8 6.5v3M8 11.2v.1" /></Icon>
}

/** Inbox glyph for empty states. */
export function IconInbox(props: IconProps) {
  return <Icon {...props}><path d="M2.5 9.5l1.7-5.2a1 1 0 0 1 .95-.7h5.7a1 1 0 0 1 .95.7l1.7 5.2M2.5 9.5v3a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1v-3M2.5 9.5h3.2a1 1 0 0 1 1 .8 1.4 1.4 0 0 0 2.6 0 1 1 0 0 1 1-.8h3.2" /></Icon>
}
