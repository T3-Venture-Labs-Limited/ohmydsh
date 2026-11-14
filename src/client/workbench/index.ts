/**
 * Entry of the lazy workbench chunk (lib/client.workbench.js): the gallery, composer, styles library, HyperFrames pane,
 * lightbox and inline tool cards. The boot bundle loads it through ../workbench-loader.ts on first use.
 */
export { StudioWorkbench } from './workbench.js'
export type { WorkbenchProps } from './workbench.js'
export { StudioToolCard, parseToolText } from './tool-card.js'
export type { ToolCardData } from './tool-card.js'
