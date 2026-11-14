/** The session-scoped `dsh-resource://file/session/<id>/<path>` address grammar a tab receives as `contentId`. */
const FILE_PREFIX = 'dsh-resource://file/session/'

export function fileOf(address: string): { sessionId: string; path: string } | null {
  if (!address.startsWith(FILE_PREFIX)) return null
  const rest = address.slice(FILE_PREFIX.length)
  const slash = rest.indexOf('/')
  if (slash <= 0 || slash === rest.length - 1) return null
  try {
    return {
      sessionId: decodeURIComponent(rest.slice(0, slash)),
      path: rest.slice(slash + 1).split('/').map((segment) => decodeURIComponent(segment)).join('/'),
    }
  } catch {
    return null
  }
}

export function titleOf(address: string): string {
  const file = fileOf(address)
  if (file === null) return 'Notebook'
  const name = file.path.slice(file.path.lastIndexOf('/') + 1)
  return name === '' ? 'Notebook' : name
}

/** Whether a path is a notebook file. */
export const isNotebookPath = (path: string): boolean => path.toLowerCase().endsWith('.ipynb')
