'use strict'
// Which URLs the window loads to show DSH, and in which order. Pure functions, unit-tested without Electron.
//
// DSH signs a window in through `<origin>/?token=<launch token>`: it answers 303 to `./` and sets the session cookie, and the
// redirect drops the query string. So "open Settings > Phone app" cannot ride on the token URL (`...&settings=phone` is lost):
// once the window is signed in it has to navigate to `<origin>/?settings=phone` WITHOUT the token, and a window that is not
// signed in yet loads the token URL first and navigates after that load finished. The token is never put on a URL that stays visible.

function parse(url) { try { return new URL(url) } catch { return undefined } }

/** Both are http(s) URLs with the same origin. */
function sameOrigin(a, b) {
  const x = parse(a); const y = parse(b)
  return x !== undefined && y !== undefined && x.origin !== 'null' && x.origin === y.origin
}

/** A DSH page of this origin that does not carry the launch token: the window is signed in and nothing secret is in the address. */
function isSignedInUrl(url, tokenUrl) {
  const u = parse(url)
  return u !== undefined && sameOrigin(url, tokenUrl) && !u.searchParams.has('token')
}

/** `<origin>/` plus the query parameters, never the token. `query` is a string ("settings=phone") or an object. */
function plainUrl(tokenUrl, query = '') {
  const u = new URL(tokenUrl)
  const target = new URL('/', u.origin)
  for (const [k, v] of new URLSearchParams(query)) if (k !== 'token') target.searchParams.set(k, v)
  return target.href
}

/**
 * @param {{ tokenUrl: string, currentUrl: string, signedIn: boolean, query?: string }} o
 *   signedIn: this window already loaded the token URL for the DSH that is running now
 * @returns {{ load?: string, then?: string }}
 *   load: URL to load first (the token URL; omitted when the window is already signed in on this origin);
 *   then: URL to navigate to once that load has finished (omitted when there is nothing more to open)
 */
function planOpen({ tokenUrl, currentUrl, signedIn, query = '' }) {
  const wanted = query === '' ? undefined : plainUrl(tokenUrl, query)
  if (signedIn && isSignedInUrl(currentUrl, tokenUrl)) return wanted === undefined ? {} : { then: wanted }
  return wanted === undefined ? { load: tokenUrl } : { load: tokenUrl, then: wanted }
}

module.exports = { planOpen, plainUrl, isSignedInUrl, sameOrigin }
