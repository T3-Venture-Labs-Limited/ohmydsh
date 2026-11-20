// Keep the tab title ohmydsh. The shell writes `document.title` itself (`<session title> — <product>`) from its
// DocumentTitle component, outside any slot, so the only hook is the <title> element. One MutationObserver on it;
// brandTitle is idempotent (its output never matches again) and the observer only writes when the value differs,
// so a rewrite can never re-trigger itself endlessly.
import { brandTitle } from '../shared/title.ts'

export function followTitle(doc: Document): () => void {
  const apply = (): void => {
    const next = brandTitle(doc.title)
    if (next !== doc.title) doc.title = next
  }
  apply()
  const observer = new MutationObserver(apply)
  observer.observe(doc.head, { childList: true, subtree: true, characterData: true })
  return () => { observer.disconnect() }
}
