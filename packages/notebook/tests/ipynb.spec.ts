// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { emptyNotebook, joinLines, parseNotebook, serializeNotebook, sortKeys, splitLines } from '../src/core/ipynb.ts'

const nb = {
  cells: [
    { cell_type: 'markdown', id: 'a1', metadata: { tags: ['x'] }, source: ['# Title\n', '![i](attachment:p.png)'], attachments: { 'p.png': { 'image/png': 'AAAA' } } },
    {
      cell_type: 'code', execution_count: 2, id: 'b2', metadata: { collapsed: false }, source: ['print(1)\n', '2'],
      outputs: [
        { name: 'stdout', output_type: 'stream', text: ['1\n', '2\n'] },
        { data: { 'text/html': ['<b>x</b>\n', '<i>y</i>'], 'image/png': 'iVBOR\n', 'application/vnd.plotly.v1+json': { a: 1 } }, metadata: { 'image/png': { width: 5 } }, output_type: 'display_data' },
        { ename: 'E', evalue: 'v', output_type: 'error', traceback: ['l1', 'l2'] },
      ],
    },
  ],
  metadata: { kernelspec: { display_name: 'Python 3', language: 'python', name: 'python3' }, widgets: { state: {} } },
  nbformat: 4,
  nbformat_minor: 5,
  vendor_key: { keep: true },
}
const text = JSON.stringify(sortKeys(nb), null, 1) + '\n'

describe('ipynb layer', () => {
  it('round-trips untouched notebooks byte for byte, keeping attachments and unknown keys', () => {
    const parsed = parseNotebook(text)
    expect('error' in parsed).toBe(false)
    if ('error' in parsed) return
    expect(serializeNotebook(parsed)).toBe(text)
    expect(parsed.cells[0]?.extras.attachments).toBeDefined()
  })
  it('joins array-form stream text and MIME text (no stray commas)', () => {
    const parsed = parseNotebook(text)
    if ('error' in parsed) throw new Error(parsed.error)
    const outputs = parsed.cells[1]?.outputs ?? []
    expect(outputs[0]?.text).toBe('1\n2\n')
    expect((outputs[1]?.data as Record<string, unknown>)['text/html']).toBe('<b>x</b>\n<i>y</i>')
  })
  it('rewrites an edited cell as lines and keeps the rest verbatim', () => {
    const parsed = parseNotebook(text)
    if ('error' in parsed) throw new Error(parsed.error)
    const cell = parsed.cells[1]
    if (cell === undefined) throw new Error('missing cell')
    cell.source = 'x = 1\ny = 2'
    const out = JSON.parse(serializeNotebook(parsed)) as typeof nb
    expect(out.cells[1]?.source).toEqual(['x = 1\n', 'y = 2'])
    expect(out.cells[1]?.outputs).toEqual(nb.cells[1]?.outputs)
    expect(out.cells[0]).toEqual(nb.cells[0])
  })
  it('upgrades minor < 5 to 5 and adds ids', () => {
    const old = JSON.stringify({ cells: [{ cell_type: 'code', source: 'a', metadata: {}, outputs: [], execution_count: null }], metadata: {}, nbformat: 4, nbformat_minor: 2 })
    const parsed = parseNotebook(old)
    if ('error' in parsed) throw new Error(parsed.error)
    const out = JSON.parse(serializeNotebook(parsed)) as { nbformat_minor: number; cells: { id: string }[] }
    expect(out.nbformat_minor).toBe(5)
    expect(out.cells[0]?.id).toMatch(/^[0-9a-f]{8}$/)
  })
  it('rejects non-notebooks with clear messages', () => {
    expect(parseNotebook('nope')).toEqual({ error: 'The file is not valid JSON.' })
    expect('error' in parseNotebook('{"nbformat":3}')).toBe(true)
  })
  it('helpers', () => {
    expect(splitLines('a\nb')).toEqual(['a\n', 'b'])
    expect(splitLines('')).toEqual([])
    expect(joinLines(['a', 'b'])).toBe('ab')
    expect(emptyNotebook().cells).toHaveLength(1)
  })
})
