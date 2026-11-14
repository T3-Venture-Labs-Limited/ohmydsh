import { defineLocale } from '../kit/index.ts'

/** English is the single source of truth; the host dictionary is registered too so a locale could be added later. */
export const locale = defineLocale('dsh-review-comments', {
  comment: 'Comment',
  commentTitle: 'Comment on the selected text',
  toolbarLabel: 'Review comment',
  popoverTitle: 'Add review comment',
  popoverPlaceholder: 'What should change here?',
  popoverHint: 'Enter to save · Shift+Enter for a new line · Esc to cancel',
  save: 'Save comment',
  cancel: 'Cancel',
  saveFailed: 'Could not save the comment: {reason}',
  quoteLabel: 'Selected text',
  chipOne: '1 comment',
  chipMany: '{n} comments',
  sendToComposer: 'Send to composer',
  sendTitle: 'Insert every open comment into the message box as its own quote chip',
  clearAll: 'Discard open comments',
  openList: 'Review comments',
  sentN: 'Added {n} to the message box',
  sendBlocked: 'The message box is busy. {n} comment(s) were added; the rest stay open.',
  sendUnavailable: 'The message box is not ready yet. Your comments are kept.',
  hostFull: 'The host copy of these comments is full (2 MB). They stay in this browser only; delete resolved comments to sync again.',
  storageMemory: 'Comments are kept in memory only (browser storage is unavailable).',
  tabTitle: 'Review',
  tabGuide: 'Review comments',
  filterOpen: 'Open',
  filterSent: 'Sent',
  filterAll: 'All',
  filterLabel: 'Filter comments',
  emptyTitle: 'No review comments yet',
  emptyBody: 'Select text in a document preview or a conversation reply, then choose Comment.',
  emptyFilteredTitle: 'Nothing in this view',
  emptyFilteredBody: 'Try another filter.',
  groupChat: 'Conversation',
  statusOpen: 'Open',
  statusSent: 'Sent',
  statusResolved: 'Resolved',
  statusResolvedByAgent: 'Resolved by agent',
  agentNote: 'Agent note',
  filterResolved: 'Resolved',
  edit: 'Edit comment',
  saveEdit: 'Save edit',
  resolve: 'Mark resolved',
  reopen: 'Reopen',
  delete: 'Delete comment',
  jump: 'Show in document',
  sendOne: 'Send this comment to the composer',
  noBody: 'No comment text',
  sendAllOpen: 'Send {n} open to composer',
  jumpCells: 'Opened the spreadsheet. Look at sheet "{sheet}", {range}.',
  jumpMissing: 'Could not find that text in the open document.',
  loc: 'Location',
})

export type Key = keyof typeof locale.en

let bound: ((key: string, params?: Record<string, unknown>) => string) | undefined

export function bindLocale(face: Parameters<typeof locale.bind>[0]): void {
  bound = locale.bind(face) as typeof bound
}
export function unbindLocale(): void { bound = undefined }

function fill(text: string, params?: Record<string, string | number>): string {
  return params === undefined ? text : text.replace(/\{(\w+)\}/g, (whole, name: string) => (name in params ? String(params[name]) : whole))
}

/** Typed translate. Reads the English source directly so rendering never depends on registration timing. */
export function t(key: Key, params?: Record<string, string | number>): string {
  void bound
  return fill(locale.en[key], params)
}
