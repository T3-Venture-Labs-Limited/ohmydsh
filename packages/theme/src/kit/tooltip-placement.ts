/** Deterministic tooltip placement from measured boxes (copied from the DSH primitives' tooltip-placement). */
export type TooltipSide = 'right' | 'left' | 'bottom' | 'top'

interface PlacementInput {
  anchor: { left: number; right: number; top: number; bottom: number }
  width: number
  height: number
  viewportWidth: number
  viewportHeight: number
  side: TooltipSide
  align: 'center' | 'end'
  gap: number
}

export interface TooltipPlacement {
  left: number
  top: number
  width: number
  height: number
  side: TooltipSide
  /** No complete side fits, so placement is bounded by the viewport instead. */
  overflow: boolean
}

const opposite: Record<TooltipSide, TooltipSide> = { right: 'left', left: 'right', top: 'bottom', bottom: 'top' }

/** Prefer the requested side, then its opposite, then the perpendicular sides, without covering the anchor. */
export function placeTooltip(input: PlacementInput): TooltipPlacement {
  const { anchor, viewportWidth, viewportHeight, side, align, gap } = input
  const margin = 12
  const width = Math.min(input.width, Math.max(0, viewportWidth - margin * 2))
  const height = Math.min(input.height, Math.max(0, viewportHeight - margin * 2))
  const clampX = (x: number) => Math.max(margin, Math.min(x, viewportWidth - margin - width))
  const clampY = (y: number) => Math.max(margin, Math.min(y, viewportHeight - margin - height))
  const horizontal = side === 'right' || side === 'left'
  const candidates: TooltipSide[] = [side, opposite[side], ...(horizontal ? (['bottom', 'top'] as const) : (['right', 'left'] as const))]
  const positions = {
    right: { left: anchor.right + 10, top: clampY((anchor.top + anchor.bottom - height) / 2) },
    left: { left: anchor.left - 10 - width, top: clampY((anchor.top + anchor.bottom - height) / 2) },
    bottom: { left: clampX(align === 'end' ? anchor.right - width : (anchor.left + anchor.right - width) / 2), top: anchor.bottom + gap },
    top: { left: clampX(align === 'end' ? anchor.right - width : (anchor.left + anchor.right - width) / 2), top: anchor.top - gap - height },
  }
  for (const candidate of candidates) {
    const p = positions[candidate]
    if (p.left >= margin && p.top >= margin && p.left + width <= viewportWidth - margin && p.top + height <= viewportHeight - margin) {
      return { ...p, side: candidate, width, height, overflow: false }
    }
  }
  const p = positions[side]
  return { left: clampX(p.left), top: clampY(p.top), side, width, height, overflow: true }
}
