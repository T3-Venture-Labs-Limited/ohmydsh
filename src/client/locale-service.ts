/** Host-provided locale service; `active` may be missing before the locale loads. */
export interface LocaleService {
  getSnapshot(): { active?: string }
  subscribe(fn: () => void): () => void
}
