// The one lazy chunk (`client.views.js`): every view that uses the kit lives here so the shared kit code sits in a
// single self-contained chunk. Never import the same module from the entry AND a lazy chunk.
export { default as Panel } from './panel.tsx'
