// Tiny shared UI state: which comment is emphasised (after a jump) and transient notices.
export interface Notice { id: number; text: string; tone: 'info' | 'error' }

let activeId: string | null = null
let notice: Notice | null = null
let seq = 0
let timer: ReturnType<typeof setTimeout> | undefined
let activeTimer: ReturnType<typeof setTimeout> | undefined
const listeners = new Set<() => void>()
const emit = (): void => { for (const l of [...listeners]) l() }

export const uiState = {
  subscribe(l: () => void): () => void { listeners.add(l); return () => { listeners.delete(l) } },
  active: (): string | null => activeId,
  notice: (): Notice | null => notice,
  setActive(id: string | null, ms = 2600): void {
    activeId = id
    if (activeTimer !== undefined) clearTimeout(activeTimer)
    if (id !== null) activeTimer = setTimeout(() => { activeId = null; emit() }, ms)
    emit()
  },
  notify(text: string, tone: Notice['tone'] = 'info', ms = 3200): void {
    notice = { id: ++seq, text, tone }
    if (timer !== undefined) clearTimeout(timer)
    timer = setTimeout(() => { notice = null; emit() }, ms)
    emit()
  },
  reset(): void {
    if (timer !== undefined) clearTimeout(timer)
    if (activeTimer !== undefined) clearTimeout(activeTimer)
    activeId = null; notice = null; listeners.clear()
  },
}
