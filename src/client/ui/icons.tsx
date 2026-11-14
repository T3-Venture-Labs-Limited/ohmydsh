// Icons drawn with currentColor strokes (same grammar as the kit icons) so they follow label tokens in both themes.
import type { SVGProps } from 'react'

type IconProps = { size?: number } & Omit<SVGProps<SVGSVGElement>, 'width' | 'height' | 'viewBox'>

function Icon({ size = 16, children, ...rest }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5}
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false" {...rest}>{children}</svg>
  )
}

export const IconComment = (p: IconProps) => <Icon {...p}><path d="M2.5 3.5a1 1 0 0 1 1-1h9a1 1 0 0 1 1 1v6.2a1 1 0 0 1-1 1H7L4.2 13.4V10.7h-.7a1 1 0 0 1-1-1V3.5zM5.5 5.8h5M5.5 8h3" /></Icon>
export const IconSend = (p: IconProps) => <Icon {...p}><path d="M13.5 2.5l-11 4.6 4.1 1.7 1.7 4.1 5.2-10.4zM6.6 8.8l3.2-3.2" /></Icon>
export const IconTrash = (p: IconProps) => <Icon {...p}><path d="M3 4.5h10M6.2 4.5V3a.8.8 0 0 1 .8-.8h2a.8.8 0 0 1 .8.8v1.5M4.4 4.5l.5 8a1 1 0 0 0 1 .9h4.2a1 1 0 0 0 1-.9l.5-8M6.8 7v4M9.2 7v4" /></Icon>
export const IconEdit = (p: IconProps) => <Icon {...p}><path d="M9.8 3.4l2.8 2.8M3 13l.5-2.8 7.6-7.6a1 1 0 0 1 1.4 0l1 1a1 1 0 0 1 0 1.4L5.9 12.5 3 13z" /></Icon>
export const IconCheck = (p: IconProps) => <Icon {...p}><path d="M3.5 8.5l3 3 6-7" /></Icon>
export const IconJump = (p: IconProps) => <Icon {...p}><path d="M6 3.5H3.8a1 1 0 0 0-1 1v7.7a1 1 0 0 0 1 1h7.7a1 1 0 0 0 1-1V10M9 2.5h4.5V7M13.2 2.8L7.5 8.5" /></Icon>
export const IconUndo = (p: IconProps) => <Icon {...p}><path d="M5.5 3.5L3 6l2.5 2.5M3.4 6h6.2a3.4 3.4 0 0 1 0 6.8H6.5" /></Icon>
