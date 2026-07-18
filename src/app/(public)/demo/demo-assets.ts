import { DEMO_IMAGE_HASHES } from "./demo-image-manifest";

/**
 * CDN base for demo images. Mirrors Next's `assetPrefix` (which only rewrites
 * `/_next/static`, not `public/`), but exposed as a `NEXT_PUBLIC_` var so the
 * value is inlined into BOTH bundles: `demoImageUrl` runs on the server (demo
 * prerender) and again on the client (the demo re-renders article content after
 * hydration), and the two must produce byte-identical URLs or React throws a
 * hydration mismatch. Empty in dev / local builds → images stay origin-served.
 * The Bunny pull zone wraps the whole site, so no per-path CDN config is needed.
 */
const CDN_BASE = process.env.NEXT_PUBLIC_ASSET_PREFIX ?? "";

/**
 * Resolve a `public/demo/*` image path (e.g. `/demo/welcome.png`) to the URL we
 * actually serve: the CDN origin plus a `?v=<content-hash>` cache-buster.
 *
 * The `?v=` hash (from the generated manifest — `pnpm generate:demo-images`) is
 * what makes CDN caching safe for these non-content-hashed filenames: the URL
 * changes exactly when an image's bytes change, so a stale copy is never served
 * across an image update. Bunny must include `v` in its cache key. A path with
 * no manifest entry falls back to an unversioned URL (still valid, just not
 * busted) so a newly-added image never 404s before the manifest is regenerated.
 */
export function demoImageUrl(path: string): string {
  const hash = DEMO_IMAGE_HASHES[path];
  const versioned = hash ? `${path}?v=${hash}` : path;
  return `${CDN_BASE}${versioned}`;
}
