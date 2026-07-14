# Outbound HTTP & SSRF Protection (`src/server/http/`)

This file governs the outbound-HTTP helpers: SSRF-protected fetching (`ssrf.ts`), user agent (`user-agent.ts`), CORS, compression, client IP, and the OAuth-surface trailing-slash handling (`trailing-slash.ts` — see `src/server/oauth/CLAUDE.md` for why it exists).

Every outgoing request must send our custom User-Agent (`USER_AGENT`/`buildUserAgent` from `@/server/http/user-agent`).

## SSRF Protection

All server-side fetches that target user-influenced URLs (feed preview/discover, feed fetching, full-content fetching, WebSub hub callbacks) are guarded against Server-Side Request Forgery to private/internal networks. The shared helper `fetchWithSsrfProtection(url, init)` in `src/server/http/ssrf.ts` performs the fetch and:

1. Rejects literal private/reserved IP hosts up front (e.g. `http://169.254.169.254/`, `http://127.0.0.1/`, IPv4-mapped IPv6 literals, decimal-encoded IPs which WHATWG `URL` normalizes to dotted form). undici skips the custom DNS lookup for IP literals, so they must be checked here.
2. Attaches a custom undici dispatcher whose DNS `lookup` resolves the hostname, blocks if **any** resolved address is private, and connects only to the vetted address — closing the DNS-rebinding TOCTOU gap.

**Redirects are validated per hop.** Because undici skips the custom `lookup` for IP-literal hosts, letting `fetch` follow redirects internally would connect to a redirect target like `http://169.254.169.254/` with **no** validation. So `fetchWithSsrfProtection` always drives the underlying fetch with `redirect: "manual"` and follows redirects itself in a loop, re-running the literal-IP check (step 1) on every hop's URL before connecting; the dispatcher (step 2) covers hostname hops. Callers that pass `redirect: "manual"` (the feed fetcher, which tracks permanent redirects itself) get the first response back unfollowed and re-enter the helper per hop; `redirect: "error"` throws on the first redirect. The loop follows up to 20 hops and applies the Fetch spec's method downgrade (301/302 on a POST, and 303, become GET with the body dropped). No caller can opt out of per-hop validation.

The helper must perform the fetch itself rather than hand the dispatcher to global `fetch`: the dispatcher is built from the npm `undici` package, while Node's global fetch is a different bundled undici copy that accepts a foreign dispatcher but skips response body decompression with it (observed on Node 26), corrupting every compressed response. `fetchWithSsrfProtection` uses the npm package's own `fetch` so the dispatcher and fetch always come from the same copy.

Blocked ranges cover loopback, RFC 1918 private, carrier-grade NAT, link-local (incl. cloud metadata), documentation/test, multicast, and reserved space for both IPv4 and IPv6 (and IPv4-mapped IPv6). Set `ALLOW_PRIVATE_NETWORK_FETCH=true` to disable the block for dev/test environments that fetch from localhost (this is the default in `.env.test`).
