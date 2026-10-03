# HTTP Helpers (`src/server/http/`)

## Outbound fetching

- **Fetch user-influenced URLs only through `fetchWithSsrfProtection`** (`ssrf.ts`; SECURITY.md §2). Its header explains the DNS pinning and per-hop redirect checks. `ALLOW_PRIVATE_NETWORK_FETCH=true` (the `.env.test` default) disables the block for local fetches.
- **Decode fetched, pushed or uploaded bodies with `decodeBody`** (`charset.ts`), never `buffer.toString()`, which turns every legacy windows-1252/Latin-1 page into U+FFFD (#1546). `readResponseWithSizeLimit` already does; callers holding raw bytes must keep the `Content-Type` with them.

## CSP

`csp.ts` builds the Content-Security-Policy (the XSS backstop; directive rationale lives there), and `src/proxy.ts` applies it. The two-tier policy and its public-page invariant are in SECURITY.md §1.

## CDN

The Bunny pull zone (`ASSET_PREFIX`, `terraform/bunny.tf`) fronts the whole site and honors origin `Cache-Control`, so **our headers decide what it caches**:

- `/_next/static` is content-hashed and `immutable`; anything `import`ed into the app lands there.
- To CDN-cache something else from client code (as `/api/prerecorded-speech/<key>` does), fetch it by an absolute `NEXT_PUBLIC_ASSET_PREFIX` URL, with a constant CORS header and an `immutable` content-addressed key.
- **HTML and RSC are never CDN-cached.** They reference build-specific chunks that vanish on the next deploy (`?_rsc=` is a router-state cache-buster, not a build id, so it doesn't make them safe either), and an edge copy would also bypass the maintenance gate (#1318). Dynamic pages keep Next's `private, no-store`; on the prerendered public pages `src/proxy.ts` replaces Next's `s-maxage` with `private, no-cache`. Caching HTML would need Next's `deploymentId` and old builds' assets kept available — a new design, not a header change.
- With `ASSET_PREFIX` set our chunks load cross-origin without CORS, so the browser resolves a runtime `import()` in them against `about:blank`: **any URL client code passes to `import()` (or to a library like ONNX Runtime's `wasmPaths`) must be absolute** (`${location.origin}/…`). Root-relative works locally and in CI and fails only in production.
