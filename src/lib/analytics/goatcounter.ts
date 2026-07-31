/**
 * GoatCounter analytics configuration.
 *
 * GoatCounter is a cookie-less page counter. We use its `/count` endpoint as a
 * backend but load **none of its JavaScript** — we build the request ourselves
 * in `./beacon` so we control exactly what is reported, and report only paths
 * from the closed vocabulary in `./paths`. Consequently there is no
 * third-party script origin anywhere in the app, and `script-src` stays
 * `'self'`; the only CSP concession is a `connect-src` entry for the beacon.
 *
 * Enabled only when `NEXT_PUBLIC_GOATCOUNTER_URL` is set. It must be a **build
 * arg** (fly.toml `[build.args]`), not a runtime env var: `NEXT_PUBLIC_*` is
 * inlined into the client, edge and nodejs bundles at build time, so a runtime
 * value has no effect anywhere. That inlining is load-bearing — the client
 * beacon and the proxy's CSP read the same frozen literal and cannot disagree
 * about whether analytics is on. Unset — the default for dev, tests, and
 * self-hosted instances — sends nothing and adds no CSP hosts.
 *
 * **The GoatCounter dashboard's "Data collection" toggles are part of our
 * privacy disclosure.** They have no representation in this repo, but the
 * privacy policy enumerates what is collected, so changing them there silently
 * makes a published claim false. As of this writing: "Individual pageviews"
 * OFF (the policy says only aggregate counts are kept — turning it on stores a
 * per-hit row with a session id), and Country + Region-for-US/RU/CN ON, which
 * the policy names explicitly. Enabling anything further needs a policy edit.
 *
 * This module is dependency-free because it is pulled into the
 * proxy/middleware bundle by `src/server/http/csp.ts`.
 */

export interface GoatCounterConfig {
  /** Count endpoint, e.g. `https://lionreader.goatcounter.com/count`. */
  endpoint: string;
  /**
   * Origin the beacon posts to. Needs a CSP `connect-src` entry (and is
   * covered for the `<img>` fallback by the existing `img-src https:`).
   */
  origin: string;
}

/** The configured GoatCounter setup, or null when analytics is disabled. */
export function goatCounterConfig(): GoatCounterConfig | null {
  const endpoint = process.env.NEXT_PUBLIC_GOATCOUNTER_URL;
  if (!endpoint) return null;
  try {
    // The beacon and the CSP both resolve through here, so a malformed value
    // disables reporting and its CSP entry together rather than shipping one
    // without the other.
    return { endpoint, origin: new URL(endpoint).origin };
  } catch {
    return null;
  }
}
