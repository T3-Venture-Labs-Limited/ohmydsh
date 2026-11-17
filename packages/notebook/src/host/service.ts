/** Registry of open notebook documents: one document, and so one kernel, per notebook file. */
import type { Context } from '@deepseek-ai/cordis'
import { NotebookDocument, NotebookError } from './document.ts'
import type { DocScope } from './document.ts'
import { displayPath, resolveNotebookPath } from './scope.ts'
import type { Settings } from './settings.ts'

export class NotebookService {
  private readonly docs = new Map<string, Promise<NotebookDocument>>()
  private readonly idle = new Map<string, NodeJS.Timeout>()

  constructor(private readonly ctx: Context, private readonly settings: Settings, private readonly driverPath: string) {}

  private keyOf(abs: string): string {
    return abs
  }

  /** Open (loading if needed) the document for a path. */
  async open(scope: DocScope & { base?: string }, path: string, options: { create?: boolean } = {}): Promise<NotebookDocument> {
    const target = await resolveNotebookPath(this.ctx, scope, path)
    const abs = this.ctx.fs.processPath(target)
    if (!abs.toLowerCase().endsWith('.ipynb')) throw new NotebookError('not-notebook', `${path} is not an .ipynb file.`)
    const key = this.keyOf(abs)
    let pending = this.docs.get(key)
    if (pending === undefined) {
      const doc = new NotebookDocument(this.ctx, target, displayPath(this.ctx, scope, target), scope, this.settings, this.driverPath)
      doc.onTouch = () => this.armIdle(key, doc)
      pending = doc.load(options.create === true).then(async () => {
        await doc.startWatching()
        return doc
      })
      this.docs.set(key, pending)
      pending.catch(() => { if (this.docs.get(key) === pending) this.docs.delete(key) })
    }
    const doc = await pending
    doc.use(scope)
    if (options.create !== true) await doc.checkDisk()
    return doc
  }

  /** Already-open documents, without loading anything. */
  async existing(scope: DocScope & { base?: string }, path: string): Promise<NotebookDocument | undefined> {
    const target = await resolveNotebookPath(this.ctx, scope, path)
    return await this.docs.get(this.keyOf(this.ctx.fs.processPath(target)))
  }

  async list(): Promise<NotebookDocument[]> {
    return (await Promise.allSettled([...this.docs.values()])).flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []))
  }

  private armIdle(key: string, doc: NotebookDocument): void {
    const minutes = this.settings.idleMinutes
    const old = this.idle.get(key)
    if (old !== undefined) clearTimeout(old)
    if (minutes <= 0) return
    const timer = setTimeout(() => {
      this.idle.delete(key)
      if (doc.viewers > 0 || doc.busy) { this.armIdle(key, doc); return }
      void this.close(key)
    }, minutes * 60_000)
    timer.unref?.()
    this.idle.set(key, timer)
  }

  async close(key: string): Promise<void> {
    const pending = this.docs.get(key)
    this.docs.delete(key)
    const timer = this.idle.get(key)
    if (timer !== undefined) clearTimeout(timer)
    this.idle.delete(key)
    const doc = await pending?.catch(() => undefined)
    await doc?.dispose()
  }

  /** A session ended: close its notebooks when nobody is looking at them. */
  async onSessionDisposed(sessionId: string): Promise<void> {
    for (const [key, pending] of [...this.docs]) {
      const doc = await pending.catch(() => undefined)
      if (doc !== undefined && doc.sessionId === sessionId && doc.viewers === 0) await this.close(key)
    }
  }

  async disposeAll(): Promise<void> {
    for (const timer of this.idle.values()) clearTimeout(timer)
    this.idle.clear()
    const all = [...this.docs.values()]
    this.docs.clear()
    await Promise.allSettled(all.map(async (pending) => (await pending).dispose()))
  }
}
