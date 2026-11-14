// Token-overlap similarity between a proposed skill and the existing ones (name + description), no model call.
const STOP = new Set('a an and are as at be by for from has have in is it its of on or that the this to use used using when with you your will can not do does also into if any all new more most skill skills'.split(' '))

export function tokens(text: string): Set<string> {
  const out = new Set<string>()
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < 3 || STOP.has(raw)) continue
    out.add(raw.length > 4 && raw.endsWith('s') ? raw.slice(0, -1) : raw)
  }
  return out
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0
  let inter = 0
  for (const x of a) if (b.has(x)) inter += 1
  return inter / (a.size + b.size - inter)
}

export interface Closest { name: string; score: number }

export function closestSkills(name: string, description: string, existing: readonly { name: string; description: string }[], limit = 3): Closest[] {
  const mine = tokens(`${name.replace(/-/g, ' ')} ${description}`)
  return existing
    .filter(e => e.name !== name)
    .map(e => ({ name: e.name, score: Math.round(jaccard(mine, tokens(`${e.name.replace(/-/g, ' ')} ${e.description}`)) * 100) / 100 }))
    .filter(c => c.score > 0)
    .sort((x, y) => y.score - x.score)
    .slice(0, limit)
}
