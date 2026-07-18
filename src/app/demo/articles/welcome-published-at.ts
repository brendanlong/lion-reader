/**
 * Resolve the "Welcome to Lion Reader" article's published time.
 *
 * This value has two hard requirements:
 *
 * 1. **SSR and client render must agree.** The demo renders the welcome article
 *    on the server (src/app/demo/**\/page.tsx) and again on the client after
 *    hydration (DemoRouter), reading the same `publishedAt` from static data.
 *    The old `new Date()` was evaluated at module-load time, which differs
 *    between the long-running server (≈ deploy time) and the browser (page
 *    load) — so the relative time jumped (e.g. "31 minutes ago" → "just now")
 *    on hydration. Reading a build/deploy-stamped value instead makes both
 *    sides render the identical time, so there is no flash.
 *
 * 2. **Welcome must stay pinned to the top** of the newest-first list
 *    (`sortNewestFirst`), so its date must be newer than every other demo
 *    article. The deploy time always is; the dev fallback is chosen to be.
 *
 * `NEXT_PUBLIC_BUILD_TIME` is stamped at deploy time as BOTH a build arg (so
 * it's inlined into the client bundle) and a runtime env var (so the server
 * reads the same value) — see the Dockerfile and .github/workflows/deploy.yml.
 * When unset (local dev, or a build that didn't stamp it) we fall back to a
 * fixed recent date. The function is pure so the parsing/fallback logic is
 * unit-tested; the impure `process.env` read stays at the call site.
 */

/** Fixed fallback published date for dev / unstamped builds. Must stay newer
 * than every other demo article so "Welcome" remains first in the list. */
export const WELCOME_FALLBACK_PUBLISHED_AT = "2026-07-01T00:00:00Z";

/**
 * Resolve the welcome article's published date from a build/deploy timestamp.
 *
 * @param buildTime An ISO-8601 timestamp (typically `NEXT_PUBLIC_BUILD_TIME`),
 *   or undefined when unstamped.
 * @returns The parsed build time, or {@link WELCOME_FALLBACK_PUBLISHED_AT} when
 *   `buildTime` is absent or not a valid date.
 */
export function resolveWelcomePublishedAt(buildTime: string | undefined): Date {
  if (buildTime) {
    const parsed = new Date(buildTime);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed;
    }
  }
  return new Date(WELCOME_FALLBACK_PUBLISHED_AT);
}
