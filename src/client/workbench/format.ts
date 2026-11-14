export function usd(value: number | undefined): string {
  if (value === undefined) return 'n/a'
  if (value === 0) return '$0'
  return value < 0.01 ? `$${value.toFixed(4)}` : `$${value.toFixed(2)}`
}
export function bytes(value: number): string {
  if (value < 1024) return `${String(value)} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(0)} KB`
  if (value < 1024 ** 3) return `${(value / 1024 / 1024).toFixed(1)} MB`
  return `${(value / 1024 ** 3).toFixed(2)} GB`
}
export function duration(ms: number | undefined): string {
  if (ms === undefined) return ''
  const total = Math.round(ms / 1000)
  return `${String(Math.floor(total / 60))}:${String(total % 60).padStart(2, '0')}`
}
export function when(ms: number): string {
  const date = new Date(ms)
  return `${date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })} ${date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`
}
export function ago(ms: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - ms) / 1000))
  if (seconds < 60) return 'just now'
  if (seconds < 3600) return `${String(Math.round(seconds / 60))} min ago`
  if (seconds < 86_400) return `${String(Math.round(seconds / 3600))} h ago`
  return `${String(Math.round(seconds / 86_400))} d ago`
}
export const clip = (text: string, length: number): string => (text.length > length ? `${text.slice(0, length - 1)}…` : text)
export const modelLabel = (id: string, labels: Readonly<Record<string, string>>): string => labels[id] ?? id.split(':').slice(1).join(':') ?? id
