# Authentication & Authorization (`src/server/auth/`)

This file governs sessions, the session cookie, API-token/OAuth-token authorization scopes, and password rate limiting (the account buckets live in `src/server/rate-limit/`). The OAuth 2.1 **server** (MCP auth surface) is covered in `src/server/oauth/CLAUDE.md`.

## Session Flow

1. Client sends session token in cookie or Authorization header
2. Server hashes token (SHA-256; tokens are 32 random bytes base64url, never stored raw), checks Redis cache
3. Cache miss: query Postgres, fill cache (TTL: 5 minutes)
4. Validate: not revoked, not expired
5. Update `last_active_at` asynchronously (on both the session row and, throttled, the denormalized `users.last_active_at` column)

`users.last_active_at` is a denormalized copy of the most recent session activity. It exists so the admin "last active" view survives retention cleanup, which deletes expired sessions (see `runRetentionCleanup`); deriving activity from `MAX(sessions.last_active_at)` would blank out any user idle longer than the 30-day session lifetime. `updateLastActiveAt` refreshes it fire-and-forget, skipping the write when it was updated within the last minute to avoid write/index churn.

## Session Cookie (`HttpOnly` + `Secure`)

The `session` cookie carries the raw token to the server on every request. It is `HttpOnly`, `Secure` in production, `SameSite=Lax`, `Path=/`, `Max-Age=30d`, so the 30-day token is **never reachable by JS** and is never sent over cleartext HTTP (issue #1088). The **server is its sole writer** — there is no client-side token management and no other cookie:

- **tRPC path (browsers).** `auth.login` / `auth.register` / `auth.googleCallback` / `auth.appleCallback` create the session and emit `Set-Cookie` on the response via the fetch adapter's `resHeaders` (threaded onto the tRPC context, see `src/server/auth/session-cookie.ts`); `auth.logout` and `users."me.deleteAccount"` clear it the same way. The browser applies the `Set-Cookie` from the mutation response, so `router.refresh()` immediately re-renders server components against the new cookie. Those mutations still **return the token in their body** for the REST/OpenAPI surface (`POST /api/v1/auth/login`, etc.), whose non-browser clients use it as a bearer token — that adapter doesn't supply `resHeaders`, so the cookie write is a no-op there and only the body token is used.
- **OAuth redirect flow** (`createSessionResponse` in `src/server/auth/oauth/callback-helpers.ts`) sets the same `HttpOnly; Secure` cookie directly on the redirect `NextResponse`.

**Detecting a dead session without reading the cookie.** Because the token is httpOnly, the client can't read it to tell "logged in" from "a login attempt just failed". It doesn't need to: the auth-error redirect (`<AuthErrorHandler>`, `src/components/app/AuthErrorHandler.tsx`) is mounted **only on the authenticated surfaces** — the app SPA (`(app)/layout.tsx`) and `/complete-signup` — whose server layouts have already redirected unauthenticated users away before the client mounts. So any request the client makes there is from a genuinely logged-in user, and an `UNAUTHORIZED` response is treated **unconditionally** as "the session died → redirect to `/login`" — no cookie, no marker, no per-procedure check. The auth/`/save`/`/demo` surfaces mount `TRPCProvider` (generic wiring) but **not** the handler, so their own expected 401s (a failed login, the bookmarklet's sign-in prompt) are handled locally and never trigger a global redirect loop. A stale httpOnly cookie after a dead-session 401 is inert — the server rejects it and it is overwritten on the next login. This makes the model fully retroactive: an existing session that dies converges on the next request with no client state to migrate.

Making the token httpOnly removes the XSS→session-token-theft path (an XSS on the `dangerouslySetInnerHTML`-rendered entry body can no longer read the cookie). `sanitizeEntryHtml` remains **security-critical** defense against XSS (see `src/server/html/CLAUDE.md`), but a bypass is no longer a one-step account takeover via the session cookie. The `admin` cookie is likewise `httpOnly: true` (`src/app/api/admin/session/route.ts`).

## Token Scopes & Authorization

Authorization is **fail-closed** for tokens. There are four credential types:

- **Browser sessions**: full access. A normal login session has `scopes = NULL`.
- **Scoped sessions**: a session with a non-NULL `scopes` array — a restricted bearer credential minted by a session-based compat API (the Google Reader `ClientLogin` mints one with `reader:full-access`). `validateSession` is **fail-closed**: a scoped session is rejected for full-access use (main tRPC/REST, RSC caller, SSE, `/oauth/authorize`) exactly as if invalid, unless the caller passes `allowScoped: true` (only the Google Reader API does, and it then verifies the reader scope). This keeps a leaked Google Reader token from being replayed as a browser session for account management.
- **API tokens** (`api_tokens`, used by extensions/integrations and the legacy MCP path): restricted to their granted scopes.
- **OAuth 2.1 access tokens**: audience-bound to the MCP endpoint (see `src/server/oauth/CLAUDE.md`). The Wallabag compat API also validates OAuth access tokens directly, requiring `reader:full-access`.

Available scopes (`API_TOKEN_SCOPES` / `OAUTH_SCOPES`):

| Scope                | Grants                                                                                                                                                                                                                           |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mcp`                | The MCP tool surface: entries list/get/mark-read/star/count, subscriptions list/get, tag CRUD, saved delete/upload                                                                                                               |
| `saved:write`        | Saving articles (`saved.save`) only                                                                                                                                                                                              |
| `reader:full-access` | Full reader surface (entries, subscriptions, tags, saved articles — not account settings). Minted for the Wallabag and Google Reader compat APIs and enforced by them; OAuth/session-only (not an `API_TOKEN_SCOPES` value yet). |

Enforcement (`src/server/trpc/trpc.ts`):

- `protectedProcedure` / `confirmedProtectedProcedure` (and their `expensive*` variants) are **session-only** — token auth is rejected with `FORBIDDEN`. This protects account-management and other non-MCP endpoints (sessions, password, preferences, ingest addresses, blocked senders, OPML import, narration, summarization, feed stats, broken feeds, feed preview/discover, subscription create/update/delete/import/export, `entries.markAllRead`, `entries.fetchFullContent`) by default.
- `scopedProtectedProcedure(scope | scope[])` opts an endpoint into token access; a token must hold at least one of the listed scopes (sessions bypass). The `mcp`-scoped endpoints mirror the MCP tools exactly; `saved.save` accepts `saved:write` or `mcp`.

Because the default is session-only, **new endpoints are token-inaccessible until they explicitly opt in**.

OAuth access tokens are validated only at `POST /api/mcp` (not in the main tRPC/REST context), where the `mcp` scope and the RFC 8707 `resource`/audience binding are both enforced. `/api/mcp` also requires signup confirmation (ToS/Privacy/EU agreement) for both OAuth and API tokens, mirroring `confirmedProtectedProcedure` on the tRPC surface.

## Password Brute-Force Protection

Every password-accepting path is rate-limited two ways. A per-IP `expensive` bucket (10 burst, 1/sec) caps a single source, and a **shared per-account** `expensive` bucket keyed by normalized (trimmed/lower-cased) email caps total guesses against one account regardless of source IP — so a distributed, IP-rotating brute-force is throttled too. The account key is shared across the tRPC `auth.login` mutation, Google Reader `ClientLogin`, and the Wallabag password grant via `checkAccountRateLimit`/`checkAccountRouteRateLimit` in `src/server/rate-limit/`. The tRPC login consumes the account bucket _before_ the user lookup so attempts against non-existent accounts are throttled identically (no enumeration side channel). The OAuth 2.1 `/oauth/token` endpoint takes no password (only `authorization_code`/`refresh_token` grants), so it has no account key and uses the generous `oauth` bucket.

Ordinary rate limits **fail open** when Redis is unavailable (availability over strictness for reads/writes). The **account** bucket is the exception: `checkAccountRateLimit` passes `fallback: "memory"`, so during a Redis outage it degrades to a per-process in-memory token bucket instead of failing fully open — password brute-force protection would otherwise evaporate exactly when the system is degraded. The in-memory map is size-bounded (LRU eviction) so an attacker rotating identifiers can't grow it without limit. Per-process (not cross-server) but it bounds guesses on each server without hard-locking legitimate users out.
