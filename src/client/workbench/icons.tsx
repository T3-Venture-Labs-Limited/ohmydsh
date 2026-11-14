import type { ReactNode, SVGProps } from 'react'

type P = { size?: number } & Omit<SVGProps<SVGSVGElement>, 'width' | 'height' | 'viewBox'>
function I({ size = 16, children, ...rest }: P & { children: ReactNode }) {
  return <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false" {...rest}>{children}</svg>
}
export const IconStar = ({ filled, ...p }: P & { filled?: boolean }) => <I {...p} fill={filled === true ? 'currentColor' : 'none'}><path d="M8 1.8l1.9 3.9 4.3.6-3.1 3 .7 4.3L8 11.5 4.2 13.6l.7-4.3-3.1-3 4.3-.6L8 1.8z" /></I>
export const IconPlay = (p: P) => <I {...p} fill="currentColor"><path d="M5 3.2v9.6L12.8 8 5 3.2z" /></I>
export const IconImage = (p: P) => <I {...p}><rect x="2" y="2.5" width="12" height="11" rx="1.5" /><circle cx="6" cy="6.5" r="1.1" /><path d="M2.5 12l3.5-3.5 2.5 2.5 2-2 3 3" /></I>
export const IconFilm = (p: P) => <I {...p}><rect x="2" y="3" width="12" height="10" rx="1.5" /><path d="M5 3v10M11 3v10M2 6h3M2 10h3M11 6h3M11 10h3" /></I>
export const IconDownload = (p: P) => <I {...p}><path d="M8 2.5v7.5M4.8 7.3L8 10.5l3.2-3.2M3 13h10" /></I>
export const IconPlus = (p: P) => <I {...p}><path d="M8 3v10M3 8h10" /></I>
export const IconCheck = (p: P) => <I {...p}><path d="M3 8.5l3.2 3.2L13 4.8" /></I>
export const IconCopy = (p: P) => <I {...p}><rect x="5.5" y="5.5" width="8" height="8" rx="1.5" /><path d="M10.5 5.5V4a1.5 1.5 0 0 0-1.5-1.5H4A1.5 1.5 0 0 0 2.5 4v5A1.5 1.5 0 0 0 4 10.5h1.5" /></I>
export const IconTrash = (p: P) => <I {...p}><path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5M7 7v4M9 7v4" /></I>
export const IconExternal = (p: P) => <I {...p}><path d="M9 3h4v4M13 3L7.5 8.5M11 9.5V12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h2.5" /></I>
export const IconUpscale = (p: P) => <I {...p}><path d="M9.5 2.5h4v4M13.5 2.5L9 7M6.5 13.5h-4v-4M2.5 13.5L7 9" /></I>
export const IconSparkle = (p: P) => <I {...p}><path d="M8 2l1.3 3.7L13 7l-3.7 1.3L8 12l-1.3-3.7L3 7l3.7-1.3L8 2zM12.5 11.5v2M11.5 12.5h2" /></I>
export const IconChevronLeft = (p: P) => <I {...p}><path d="M10 3.5L5.5 8l4.5 4.5" /></I>
export const IconChevronRight = (p: P) => <I {...p}><path d="M6 3.5L10.5 8 6 12.5" /></I>
export const IconStop = (p: P) => <I {...p}><rect x="4" y="4" width="8" height="8" rx="1" /></I>
export const IconRefresh = (p: P) => <I {...p}><path d="M13 8a5 5 0 1 1-1.5-3.5M13 2.5v3h-3" /></I>
export const IconLayers = (p: P) => <I {...p}><path d="M8 2.5l6 3-6 3-6-3 6-3zM2 8.5l6 3 6-3M2 11.5l6 3 6-3" /></I>
export const IconPalette = (p: P) => <I {...p}><path d="M8 2.5a5.5 5.5 0 1 0 0 11c1 0 1.4-.7 1.1-1.5-.3-.8.1-1.5 1-1.5H12a1.5 1.5 0 0 0 1.5-1.5C13.5 5.5 11 2.5 8 2.5z" /><circle cx="5.2" cy="7.5" r=".6" fill="currentColor" /><circle cx="8" cy="5.2" r=".6" fill="currentColor" /><circle cx="10.8" cy="7.2" r=".6" fill="currentColor" /></I>
export const IconFolder = (p: P) => <I {...p}><path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h2.8l1.5 1.7h4.7A1.5 1.5 0 0 1 14 6.2v5.3A1.5 1.5 0 0 1 12.5 13h-9A1.5 1.5 0 0 1 2 11.5v-7z" /></I>
export const IconSelect = (p: P) => <I {...p}><rect x="2.5" y="2.5" width="11" height="11" rx="2" /><path d="M5.5 8.2l2 2 3.2-3.8" /></I>
