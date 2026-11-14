// Minimal line-based unified diff (LCS) for showing an improvement against the current SKILL.md.
export interface DiffStats { added: number; removed: number; changedRatio: number }

export function unifiedDiff(a: string, b: string, context = 3, labels: [string, string] = ['current', 'proposed']): { text: string; stats: DiffStats } {
  const A = a.split('\n')
  const B = b.split('\n')
  const n = A.length
  const m = B.length
  // LCS table (files are capped well below the O(n*m) limit by the validator's size warning; guard anyway).
  if (n * m > 4_000_000) {
    return { text: `--- ${labels[0]}\n+++ ${labels[1]}\n(too large to diff; showing replacement)\n`, stats: { added: m, removed: n, changedRatio: 1 } }
  }
  const lcs: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1))
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) lcs[i]![j] = A[i] === B[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!)
  }
  type Op = { t: ' ' | '+' | '-'; line: string; ai: number; bi: number }
  const ops: Op[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (A[i] === B[j]) { ops.push({ t: ' ', line: A[i]!, ai: i, bi: j }); i += 1; j += 1 }
    else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) { ops.push({ t: '-', line: A[i]!, ai: i, bi: j }); i += 1 }
    else { ops.push({ t: '+', line: B[j]!, ai: i, bi: j }); j += 1 }
  }
  for (; i < n; i += 1) ops.push({ t: '-', line: A[i]!, ai: i, bi: j })
  for (; j < m; j += 1) ops.push({ t: '+', line: B[j]!, ai: i, bi: j })
  const added = ops.filter(o => o.t === '+').length
  const removed = ops.filter(o => o.t === '-').length
  const stats: DiffStats = { added, removed, changedRatio: Math.max(1, Math.max(n, m)) === 0 ? 0 : (added + removed) / (n + m || 1) }
  if (added + removed === 0) return { text: '', stats }
  const keep = new Array<boolean>(ops.length).fill(false)
  ops.forEach((o, k) => { if (o.t !== ' ') for (let d = -context; d <= context; d += 1) { const p = k + d; if (p >= 0 && p < ops.length) keep[p] = true } })
  const out: string[] = [`--- ${labels[0]}`, `+++ ${labels[1]}`]
  let k = 0
  while (k < ops.length) {
    if (!keep[k]) { k += 1; continue }
    let end = k
    while (end < ops.length && keep[end]) end += 1
    const hunk = ops.slice(k, end)
    const aStart = hunk[0]!.ai + 1
    const bStart = hunk[0]!.bi + 1
    const aLen = hunk.filter(o => o.t !== '+').length
    const bLen = hunk.filter(o => o.t !== '-').length
    out.push(`@@ -${String(aStart)},${String(aLen)} +${String(bStart)},${String(bLen)} @@`)
    for (const o of hunk) out.push(`${o.t}${o.line}`)
    k = end
  }
  return { text: `${out.join('\n')}\n`, stats }
}
