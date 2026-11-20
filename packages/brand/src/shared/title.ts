import { PRODUCT_NAME } from './config.ts'

/** The names the stock shell puts after (or instead of) the session title. */
const STOCK_NAMES = ['DeepSeek Harness', 'DSH Local Build']

/**
 * Rewrite the shell's product name in a document title. The shell writes `<session title> — <product>` (or just
 * `<product>`); only that trailing/exact product name is replaced, so a session that is *about* DeepSeek Harness
 * keeps its own title. Idempotent: the result never matches again, which is what stops the observer looping.
 */
export function brandTitle(title: string, name: string = PRODUCT_NAME): string {
  for (const stock of STOCK_NAMES) {
    if (title === stock) return name
    if (title.endsWith(` — ${stock}`)) return `${title.slice(0, -stock.length)}${name}`
  }
  return title
}
