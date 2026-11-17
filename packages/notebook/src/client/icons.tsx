import type { JSX } from 'react'

const base = { width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true, focusable: false } as const
export const IconPlay = (): JSX.Element => <svg {...base}><path d="M5 3.5v9l7-4.5z" /></svg>
export const IconStop = (): JSX.Element => <svg {...base}><rect x="4" y="4" width="8" height="8" rx="1" /></svg>
export const IconUp = (): JSX.Element => <svg {...base}><path d="M4 10l4-4 4 4" /></svg>
export const IconDown = (): JSX.Element => <svg {...base}><path d="M4 6l4 4 4-4" /></svg>
export const IconTrash = (): JSX.Element => <svg {...base}><path d="M3 4.5h10M6.5 4.5V3h3v1.5M5 4.5l.5 8h5l.5-8" /></svg>
export const IconSave = (): JSX.Element => <svg {...base}><path d="M3 3h8l2 2v8H3zM5.5 3v3h4V3M5.5 13V9h5v4" /></svg>
export const IconRestart = (): JSX.Element => <svg {...base}><path d="M13 8a5 5 0 1 1-1.6-3.7M13 3v3h-3" /></svg>
export const IconRunAll = (): JSX.Element => <svg {...base}><path d="M2.5 3.5v9l5-4.5zM8.5 3.5v9l5-4.5z" /></svg>
export const IconClear = (): JSX.Element => <svg {...base}><path d="M3 13l7-7 3 3-4 4H3zM8 8l3 3" /></svg>
export const IconPlus = (): JSX.Element => <svg {...base}><path d="M8 3v10M3 8h10" /></svg>
