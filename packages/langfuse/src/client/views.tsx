// The one lazy chunk (`client.views.js`): every view that uses the kit lives here so the shared kit code sits in a
// single self-contained chunk. Never import this module from the entry synchronously or from another lazy chunk.
export { default as SettingsPage } from './settings-page.tsx'
export { default as OpenTraceAction } from './open-trace.tsx'
