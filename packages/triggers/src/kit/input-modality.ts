/** Last-input tracking so tooltips ignore the programmatic focus that follows a click (a closing menu refocusing its trigger). */
let pointer = false
let refs = 0
const onPointer = () => { pointer = true }
const onKey = () => { pointer = false }

/** Whether the last input was a pointer. */
export function pointerModality(): boolean {
  return pointer
}

/** Start tracking while at least one tooltip is mounted; returns the release function. */
export function trackInputModality(): () => void {
  if (typeof window === 'undefined') return () => {}
  if (refs++ === 0) {
    window.addEventListener('pointerdown', onPointer, true)
    window.addEventListener('keydown', onKey, true)
  }
  let released = false
  return () => {
    if (released) return
    released = true
    if (--refs === 0) {
      window.removeEventListener('pointerdown', onPointer, true)
      window.removeEventListener('keydown', onKey, true)
    }
  }
}
