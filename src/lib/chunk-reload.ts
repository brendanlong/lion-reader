/**
 * Blocking <head> script that recovers from webpack `ChunkLoadError`.
 *
 * Every App Router page — even a fully SSR'd one like the demo — ships a client
 * bundle to hydrate the markup into an interactive React tree, split into
 * content-hashed chunks under `/_next/static/chunks/`. When the browser loads
 * HTML from build A but the origin has since deployed build B (whose chunks have
 * different hashes), the request for `chunks/<id>-<hashA>.js` 404s and hydration
 * throws `ChunkLoadError`. Our public pages are CDN-cached (see
 * `src/server/http/page-cache.ts`), which widens the window in which a visitor
 * can be served stale HTML that points at a chunk the current build no longer
 * has. A deploy-time CDN purge shrinks that window; this makes an individual tab
 * that still hits it self-heal.
 *
 * Why an inline head script rather than a "use client" component: the thing that
 * fails is chunk loading, so a recovery handler that itself lives in a chunk and
 * only registers its listener from a `useEffect` after hydration is unreliable —
 * hydration can throw the `ChunkLoadError` before that effect ever commits. Run
 * inline in <head> (like `themeScript` / the appearance script in
 * `src/app/layout.tsx`) the listener is registered before any chunk loads and
 * covers every route from the single root-layout mount.
 *
 * On a chunk error we force one full reload, which re-fetches the current HTML
 * (browsers revalidate our pages — `max-age=0`) and with it the current chunk
 * hashes. The reload is guarded by a short time window in `sessionStorage` so
 * that if the reload comes back still referencing the missing chunk (e.g. the
 * CDN is briefly still serving the stale copy) we don't spin in a reload loop —
 * we reload at most once per `RELOAD_WINDOW_MS`, then let the error surface. A
 * genuinely later mismatch (a deploy mid-session) is outside the window and
 * still recovers. The generated string is pinned by
 * `tests/unit/chunk-reload.test.ts`.
 */

/** Don't reload more than once per this window, so a still-broken reload can't loop. */
export const RELOAD_WINDOW_MS = 10_000;

/** `sessionStorage` key holding the epoch-ms of the last recovery reload. */
export const RELOAD_TIMESTAMP_KEY = "lr-chunk-reload-at";

export function buildChunkReloadScript(): string {
  return `
(function() {
  var KEY = ${JSON.stringify(RELOAD_TIMESTAMP_KEY)};
  var WINDOW_MS = ${RELOAD_WINDOW_MS};
  function isChunkError(err) {
    if (!err) return false;
    if (typeof err.name === 'string' && err.name === 'ChunkLoadError') return true;
    var msg = typeof err.message === 'string'
      ? err.message
      : (typeof err === 'string' ? err : '');
    return msg.indexOf('ChunkLoadError') !== -1 ||
      /Loading( CSS)? chunk [^\\s]+ failed/i.test(msg);
  }
  function recover(err) {
    if (!isChunkError(err)) return;
    var now = Date.now();
    var last = 0;
    try { last = parseInt(window.sessionStorage.getItem(KEY), 10) || 0; } catch (e) {}
    if (now - last < WINDOW_MS) return;
    try { window.sessionStorage.setItem(KEY, String(now)); } catch (e) {}
    window.location.reload();
  }
  window.addEventListener('error', function(e) { recover(e && e.error); });
  window.addEventListener('unhandledrejection', function(e) { recover(e && e.reason); });
})();
`;
}
