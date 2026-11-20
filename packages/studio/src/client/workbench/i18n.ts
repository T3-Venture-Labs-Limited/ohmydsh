// English-only typed dictionary: a missing key is a compile error, and a locale could be added by swapping `en`.
export const en = {
  studio: 'Studio',
  tabCreate: 'Create', tabGallery: 'Gallery', tabStyles: 'Styles', tabVideo: 'Video edit',
  loading: 'Loading Studio…',
  // gallery
  searchPrompts: 'Search prompts, tags, notes', all: 'All', images: 'Images', videos: 'Videos', favorites: 'Favourites', fromChats: 'From chats',
  fromChat: 'From chat', openChat: 'Open chat', untitledChat: 'Untitled chat', chatGone: 'Chat not available', madeByTool: 'Made by {tool}',
  importAgent: 'Import agent images and videos', importAgentBusy: 'Importing…', importAgentTitle: 'Import agent images and videos',
  importAgentHint: 'Looks through your existing chats and the agent media folders and adds everything the agent generated that is not in the gallery yet. Nothing is moved or deleted.',
  importAgentRun: 'Import now', importAgentDone: 'Import finished', importedN: 'Imported', alreadyThereN: 'Already there', skippedN: 'Skipped', failedN: 'Failed',
  scannedChats: 'Chats scanned', scannedFiles: 'Files scanned', lastRun: 'Last run',
  anyTag: 'Any tag', anyModel: 'Any model', anyCollection: 'Any collection', spend: 'Spend', select: 'Select', selectedN: '{n} selected',
  clear: 'Clear', downloadZip: 'Download ZIP', addTag: 'Add tag', addToCollection: 'Add to collection', deleteSelected: 'Delete',
  newCollection: 'New collection…', collectionName: 'Collection name', create: 'Create', cancel: 'Cancel',
  emptyGallery: 'Nothing here yet', emptyGalleryHint: 'Generate something in Create, drop a file here, or loosen the filters.',
  loadMore: 'Load more', nOfTotal: '{n} of {total}', dropToImport: 'Drop images or videos to import them',
  importFiles: 'Import files', importing: 'Importing…', recent: 'Recent', openGallery: 'Open gallery',
  confirmDelete: 'Delete {n} item(s)? They are hidden now and purged after 30 days.', delete: 'Delete',
  addFavorite: 'Add to favourites', removeFavorite: 'Remove from favourites', selectItem: 'Select', openItem: 'Open',
  // spend
  spendTitle: 'Spend', spendHint: 'Recorded costs of generated assets: provider-reported when available, otherwise estimates.', last30: 'Last 30 days', last7: 'Last 7 days', allTime: 'All time',
  total: 'Total', perDay: 'Per day', perProvider: 'Per provider', noSpend: 'No recorded spend in this range.', assetsN: '{n} asset(s)', stored: '{count} assets · {size}',
  // lightbox
  prompt: 'Prompt', negativePrompt: 'Negative prompt', model: 'Model', params: 'Parameters', created: 'Created', size: 'Size', cost: 'Cost', seed: 'Seed', source: 'Source',
  copy: 'Copy', copied: 'Copied', reusePrompt: 'Reuse prompt', openInComposer: 'Open in composer', useAsReference: 'Use as reference', useAsSource: 'Use as source',
  upscale: 'Upscale', animate: 'Animate', restyle: 'Restyle', extend: 'Extend', download: 'Download', openInHyperFrames: 'Open in HyperFrames', tags: 'Tags', collections: 'Collections',
  addTagPlaceholder: 'Add tag…', lineage: 'Lineage', lineageEmpty: 'No parents or derived assets yet.', thisAsset: 'This asset', parents: 'Made from', children: 'Derived', rating: 'Rating',
  actions: 'Actions', details: 'Details', previous: 'Previous', next: 'Next', close: 'Close', unknownModel: 'Imported', costProvider: 'provider-reported', costEstimate: 'estimate',
  title: 'Title', notes: 'Notes', save: 'Save',
  // composer
  operation: 'Operation', opGenerate: 'Generate', opEdit: 'Edit', opUpscale: 'Upscale', opAnimate: 'Animate', opRestyle: 'Restyle', opExtend: 'Extend',
  kind: 'Output', kindImage: 'Image', kindVideo: 'Video', promptPlaceholder: 'Describe what to make…', promptPlaceholderEdit: 'Describe the change…',
  advanced: 'More options', noModel: 'No model available for this combination.', noModelHint: 'Add an API key in Settings > Plugins > Studio, or change the operation.',
  needsKey: '{provider} has no API key yet. Add it in Settings > Plugins > Studio.', estimate: 'Estimate', estimating: 'Estimating…', estimateUnknown: 'Estimate unavailable',
  generateBtn: 'Generate', runBtn: 'Run', compareWith: 'Compare with', compareHint: 'Run the same request on other models side by side.', compareN: '{n} models',
  sourceTray: 'Source', referencesTray: 'References', firstFrameTray: 'First frame', lastFrameTray: 'Last frame', videoTray: 'Source video',
  addFromGallery: 'From gallery', uploadFile: 'Upload', dropHere: 'Drop, paste or pick', remove: 'Remove', pickAsset: 'Pick from gallery', maxN: 'up to {n}',
  needSource: 'Pick a source first.', needPrompt: 'Write a prompt first.', submitFailed: 'Could not start the job',
  providerOff: 'no key', tierQuality: 'quality', tierValue: 'value', tierDraft: 'draft',
  // jobs
  jobs: 'Jobs', noJobs: 'No jobs yet.', retry: 'Retry', cancelJob: 'Cancel', openRequest: 'Open in composer', dismiss: 'Dismiss', clearFinished: 'Clear finished',
  stateQueued: 'Queued', stateSubmitting: 'Submitting', stateRunning: 'Running', stateFinalizing: 'Finalizing', stateSucceeded: 'Done', stateFailed: 'Failed', stateCanceled: 'Canceled', stateNeedsAttention: 'Needs attention',
  needsAttention: 'This needs you: fix the API key or credits in Settings > Plugins > Studio, then retry.', live: 'Live', offline: 'Reconnecting…',
  estShort: 'est. {usd}', costShort: '{usd}', compareGroup: 'Compare · {n} models', openCompare: 'Side by side', compareTitle: 'Compare runs', keepBest: 'Favourite this one', waiting: 'Waiting…',
  // styles
  stylesLibrary: 'Library', stylesFavorites: 'My favourites', stylesExamples: 'Model examples', searchStyles: 'Search styles', allCategories: 'All',
  useStyle: 'Use', copyPrompt: 'Copy prompt', styleSubject: 'your subject', styleHint: 'Style prompts are plain text written for Studio. Type a subject below and it is woven into every prompt; Use sends the prompt to the composer.', subjectPlaceholder: 'Your subject (optional), e.g. a lighthouse at dusk',
  noFavorites: 'No favourites yet', noFavoritesHint: 'Star images and videos in the gallery and they appear here, ready to reuse.',
  makeVideo: 'Make video', examplesNeedToken: 'Live model examples need a Replicate API token', examplesNeedTokenHint: 'Add REPLICATE_API_TOKEN in Settings > Plugins > Studio. Examples are loaded live and linked, never bundled.',
  examplesPick: 'Model', examplesNone: 'No examples for this model.', remix: 'Remix', viewOnReplicate: 'View on Replicate', viewOnOpenRouter: 'See examples on OpenRouter', exampleSource: 'Examples from Replicate, hosted by their authors.',
  examplesNotReplicate: 'Pick a Replicate model to see its live examples. Other providers are linked below.',
  // hyperframes
  hfTitle: 'HyperFrames Studio', hfHint: 'Edit clips, captions and titles in HyperFrames Studio, then bring renders back to the gallery.', hfMissing: 'HyperFrames CLI not found',
  hfInstall: 'Install it with: npm i -g hyperframes. Then press Retry.', hfOpen: 'Open project', hfNew: 'New project', hfFromSelection: 'New project from selected clips',
  hfNewEmpty: 'New empty project', hfStop: 'Stop preview', hfImport: 'Import renders', hfImported: 'Imported {n} render(s)', hfNoRenders: 'No new renders found', hfOpenExternal: 'Open externally',
  hfRemote: 'The preview listens on the machine running ohmydsh. Open this address there:', hfStarting: 'Starting preview…', hfProjects: 'Projects', hfRunning: 'running', hfIdle: 'stopped',
  hfSlug: 'Project name', hfFailed: 'Could not open HyperFrames', hfPickClips: 'Select videos in the gallery first, then open them here.', retryBtn: 'Retry', hfBack: 'Projects',
  // legacy import
  legacyImport: 'Import from Image Studio', legacyHint: 'Brings the gallery of the old Image Studio plugin into Studio. Safe to run again: nothing is imported twice.', legacyRun: 'Import', legacyFound: '{n} records in the old gallery · {left} still to import', legacySummary: 'Imported {imported}, already there {skipped}, file missing {missing}.',
  // mask editor / outpaint
  inpaint: 'Inpaint', expandCanvas: 'Expand canvas', editImage: 'Edit image', paintMask: 'Paint mask', toolBrush: 'Brush', toolEraser: 'Eraser', toolRect: 'Rectangle', toolLasso: 'Lasso',
  undo: 'Undo', redo: 'Redo', clearMask: 'Clear', invertMask: 'Invert', fillMask: 'Fill all', brushSize: 'Brush size', growEdges: 'Grow edges', growHint: 'Widens the painted area so the new pixels blend with the old ones.',
  showKeep: 'Preview kept area', maskHint: 'Paint the area the model should change. Everything else stays exactly as it is.',
  maskEmpty: 'Nothing is painted yet.', maskFull: 'Almost everything is painted. Use Edit instead of Inpaint.', maskCoverage: '{pct}% of the image will change',
  inpaintPrompt: 'What should appear in the painted area?', runInpaint: 'Run inpaint', runExpand: 'Expand and fill', noInpaintModel: 'No inpaint model is available. Add an API key for OpenRouter, Replicate or ComfyUI in Settings > Plugins > Studio.',
  modeMask: 'This model receives your mask directly.', modeMarkup: 'This model receives your mask as an overlay on the image.', modeOverlay: 'This model gets a tinted copy of the image and an instruction; the result is pasted back so untouched pixels stay identical.',
  expandTop: 'Top', expandRight: 'Right', expandBottom: 'Bottom', expandLeft: 'Left', expandOverlap: 'Overlap', expandHint: 'Pixels to add on each side. The new area is filled in by the model; {n}px of the old edge are repainted so the seam blends.',
  expandResult: 'Result: {w} × {h}px', expandTooBig: 'The result may be at most 8192 px per side.', expandNone: 'Add pixels to at least one side.', expandPreset: 'Presets', expandAll: 'All sides', uploadingMask: 'Saving mask…', submittingJob: 'Starting job…', jobStarted: 'Inpaint job started. Follow it in Jobs.',
  openInStudio: 'Open in Studio',
  // tool card
  toolRunning: 'Working…', toolNoAssets: 'No assets in this result.', toolGalleryN: '{n} assets',
  error: 'Error', unknownError: 'Something went wrong',
} as const

export type Key = keyof typeof en
export function t(key: Key, params?: Readonly<Record<string, string | number>>): string {
  const raw: string = en[key]
  if (params === undefined) return raw
  return raw.replace(/\{(\w+)\}/g, (_all, name: string) => (name in params ? String(params[name]) : `{${name}}`))
}
