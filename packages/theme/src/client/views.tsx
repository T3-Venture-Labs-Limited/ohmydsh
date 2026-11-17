// The one lazy chunk (`client.views.js`): every view that uses the kit lives here so the shared kit code sits in a
// single self-contained chunk. The loader cannot resolve a synchronous `require("./client.<other>.js")`, so never
// import the same module from the entry AND a lazy chunk, or from two different lazy chunks.
export { default as SettingsPage } from './settings-page.tsx'
