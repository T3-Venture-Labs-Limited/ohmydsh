// English dictionary: the typed source of truth for every UI string. `{name}` placeholders are filled from params.
// Import the helper directly (not the kit barrel): the entry must not pull kit components onto the boot path.
import { defineLocale } from '../kit/locale.ts'

export const locale = defineLocale('dsh-langfuse', {
  nav: 'Langfuse tracing',
  pageTitle: 'Langfuse tracing',
  pageDescription: 'Every agent turn is sent to Langfuse as one trace: model calls, tools, subagents and token usage. Keys and the server address come from the environment (LANGFUSE_PUBLIC_KEY, LANGFUSE_SECRET_KEY, LANGFUSE_BASE_URL); other options live in the plugin configuration.',
  sectionStatus: 'Status',
  statusTitle: 'Tracing',
  statusOn: 'Sending traces',
  statusOff: 'Off',
  statusUnknown: 'Checking…',
  statusUnreachable: 'The Host did not answer. Is the plugin loaded?',
  serverTitle: 'Server',
  environmentTitle: 'Environment',
  offReason: 'Reason: {reason}',
  recheck: 'Check again',
  openTrace: 'Open trace in Langfuse',
  openTraceBusy: 'Finding trace…',
  openTraceFailed: 'No trace: {reason}',
})

export type T = ReturnType<typeof locale.bind>
