/** Minimal ANSI SGR parser: colours map to theme-token classes (see styles.css `.nb-ansi--*`), never literal colours. */
export interface AnsiSpan { text: string; classes: string[] }

const COLOUR: Record<number, string> = { 30: 'gray', 31: 'red', 32: 'green', 33: 'yellow', 34: 'blue', 35: 'magenta', 36: 'cyan', 37: 'gray', 90: 'gray', 91: 'red', 92: 'green', 93: 'yellow', 94: 'blue', 95: 'magenta', 96: 'cyan', 97: 'gray' }

// eslint-disable-next-line no-control-regex
const CSI = /\u001b\[([0-9;]*)m/g
// eslint-disable-next-line no-control-regex
const OTHER = /\u001b\[[0-9;?]*[ -/]*[@-ln-~]|\u001b\][^\u0007]*\u0007/g

export function parseAnsi(input: string): AnsiSpan[] {
  const text = input.replace(OTHER, '')
  const spans: AnsiSpan[] = []
  let classes: string[] = []
  let last = 0
  for (const match of text.matchAll(CSI)) {
    if (match.index > last) spans.push({ text: text.slice(last, match.index), classes })
    last = match.index + match[0].length
    const codes = (match[1] ?? '').split(';').filter((c) => c !== '').map(Number)
    if (codes.length === 0) codes.push(0)
    for (let i = 0; i < codes.length; i++) {
      const code = codes[i] as number
      if (code === 0) classes = []
      else if (code === 1) classes = [...classes.filter((c) => c !== 'bold'), 'bold']
      else if (code === 2) classes = [...classes.filter((c) => c !== 'dim'), 'dim']
      else if (code === 22) classes = classes.filter((c) => c !== 'bold' && c !== 'dim')
      else if (code === 39) classes = classes.filter((c) => !Object.values(COLOUR).includes(c))
      else if (COLOUR[code] !== undefined) classes = [...classes.filter((c) => !Object.values(COLOUR).includes(c)), COLOUR[code] as string]
      else if (code === 38 || code === 48) i += codes[i + 1] === 5 ? 2 : 4 // skip 256-colour / truecolour operands
    }
  }
  if (last < text.length) spans.push({ text: text.slice(last), classes })
  return spans
}
