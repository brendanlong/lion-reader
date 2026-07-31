/**
 * First-party analytics beacon.
 *
 * We build GoatCounter's `/count` request ourselves instead of loading their
 * `count.js`. That script's entire job is deriving the request parameters from
 * the page — which is exactly the part we must not delegate: it reports the
 * full query string (as `p`, and again raw as `q`, which no setting can
 * suppress) plus `document.title`, and our URLs and titles carry invite
 * tokens, entry ids and article titles.
 *
 * Doing it here means:
 * - No third-party script anywhere, so `script-src` stays `'self'` in both CSP
 *   tiers and there is no SRI pin or upstream version to track.
 * - The reported path comes from a closed vocabulary (`./paths`), never from
 *   `location`.
 * - It is ordinary testable code rather than an opaque blob.
 *
 * Server-side behaviour is unaffected: GoatCounter still does its own
 * user-agent bot filtering, and its visitor de-duplication is an in-memory
 * IP+UA mapping on their side, so "visitors" counts work exactly as before.
 *
 * The parameter names below are GoatCounter's documented `/count` API.
 */

import { goatCounterConfig } from "./goatcounter";
import type { AnalyticsPath } from "./paths";

/**
 * Bot signals `count.js` checks client-side, kept because GoatCounter's
 * server-side filtering can't see them. The numbers are their documented codes.
 */
function botReason(): number {
  const w = window as unknown as Record<string, unknown>;
  const d = document as unknown as Record<string, unknown>;
  if (w.callPhantom || w._phantom || w.phantom) return 150;
  if (w.__nightmare) return 151;
  if (d.__selenium_unwrapped || d.__webdriver_evaluate || d.__driver_evaluate) return 152;
  if (navigator.webdriver) return 153;
  return 0;
}

/**
 * The referrer, but only when it is **cross-origin**.
 *
 * Same-origin referrers are both useless (we already know the previous page)
 * and dangerous: navigating away from `/register?invite=<token>` would
 * otherwise report that token as the referrer of the next page — the same leak
 * the path vocabulary exists to prevent, arriving through a different field.
 * Only the origin is sent, never the external path, which is all "where did
 * people come from" needs.
 */
function crossOriginReferrer(): string | null {
  const raw = document.referrer;
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return url.origin === window.location.origin ? null : url.origin;
  } catch {
    return null;
  }
}

/**
 * GoatCounter's own local-traffic filter, which we no longer inherit — plus the
 * cases theirs misses. IPv6 loopback (`[::1]`) and the carrier-grade NAT range
 * that Tailscale uses (100.64/10) both look like real traffic otherwise, which
 * is how a production image run locally pollutes the live dashboard. `localhost`
 * is anchored: unanchored, it also matched any host merely *ending* in it.
 */
function isLocalHost(): boolean {
  const { hostname, protocol } = window.location;
  if (protocol === "file:") return true;
  return /^(localhost|\[?::1\]?|0\.0\.0\.0)$|\.localhost$|^127\.|^10\.|^172\.(1[6-9]|2[0-9]|3[0-1])\.|^192\.168\.|^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(
    hostname
  );
}

/**
 * `document.referrer` is fixed for the life of the document, but this is a
 * pushState SPA that beacons on every route change and entry open — so sending
 * it every time would report one arrival from Hacker News as forty. Report it
 * on the first beacon only, which is the one that represents the arrival.
 */
let referrerReported = false;

/**
 * Builds the `/count` URL for a page view. Exported for tests — the assertion
 * that matters is what is *absent* (no query string, no title, no ids).
 */
export function buildCountUrl(
  endpoint: string,
  path: AnalyticsPath,
  nonce: string,
  reportReferrer = true
): string {
  const params = new URLSearchParams({
    p: path,
    // Screen width only. GoatCounter aggregates widths; height and pixel ratio
    // add fingerprinting surface for a number nobody looks at.
    s: String(window.screen.width),
    // Browsers don't always honour Cache-Control on this endpoint.
    rnd: nonce,
  });
  // `t` (title) is deliberately never sent: document.title contains the
  // article being read. GoatCounter falls back to displaying the path.
  const referrer = reportReferrer ? crossOriginReferrer() : null;
  if (referrer) params.set("r", referrer);
  const bot = botReason();
  if (bot) params.set("b", String(bot));
  return `${endpoint}?${params.toString()}`;
}

/**
 * Reports one page view. Safe to call anywhere: a no-op when analytics is
 * unconfigured (dev, tests, self-hosted) or on a local address.
 */
export function trackPageView(path: AnalyticsPath): void {
  const config = goatCounterConfig();
  if (!config || typeof window === "undefined" || isLocalHost()) return;

  const nonce = Math.random().toString(36).slice(2, 7);
  const url = buildCountUrl(config.endpoint, path, nonce, !referrerReported);
  referrerReported = true;

  // sendBeacon survives the page unloading. It can be refused (CSP, or a
  // browser that doesn't implement it), so fall back to an image request —
  // analytics must never throw into the app.
  try {
    if (navigator.sendBeacon?.(url)) return;
  } catch {
    // fall through to the image fallback
  }
  try {
    new Image().src = url;
  } catch {
    // Reporting is best-effort; never surface a failure to the user.
  }
}
