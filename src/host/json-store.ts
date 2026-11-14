// Small atomic JSON file store shared by the DSH-only state files (settings, evolution config, proposals).
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export class JsonStore<T> {
  private value: T
  private writing: Promise<void> = Promise.resolve()

  constructor(readonly file: string, private readonly normalize: (input: unknown) => T) {
    this.value = normalize(undefined)
  }

  get current(): T { return this.value }

  async load(): Promise<void> {
    try { this.value = this.normalize(JSON.parse(await readFile(this.file, 'utf8'))) } catch { this.value = this.normalize(undefined) }
  }

  /** Mutate a copy, publish it immediately, then persist atomically (0600). Writers are serialized. */
  async update(mutate: (draft: T) => void): Promise<T> {
    const draft = structuredClone(this.value)
    mutate(draft)
    this.value = this.normalize(draft)
    const text = JSON.stringify(this.value, null, 2)
    this.writing = this.writing.then(async () => {
      await mkdir(dirname(this.file), { recursive: true })
      const tmp = `${this.file}.${String(process.pid)}.tmp`
      await writeFile(tmp, text, { mode: 0o600 })
      await rename(tmp, this.file)
    })
    await this.writing
    return this.value
  }
}
