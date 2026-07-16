# Security-Critical Code Map

This document is the index of the **security-critical** parts of Lion Reader: the
code where a mistake becomes a vulnerability (XSS, SSRF, auth bypass, cross-user
data leak) rather than a bug. It exists so that reviewers and anyone changing these
areas know what invariant they must not break and where the detailed rules live.

**If you are reviewing or modifying any file listed here, read the linked
per-directory `CLAUDE.md` first, and treat the invariant in bold as a hard
requirement.** The per-directory docs hold the deep rules; this file is the map.

Reporting a vulnerability: email self@brendanlong.com. Do not open a public issue
for an unpatched vulnerability.

---

## Threat model in one paragraph

Feed and article content is **fully attacker-controlled** (anyone can publish a
feed a user subscribes to, or have a user save an arbitrary URL). Users are
**mutually untrusted**: entries and feeds are shared at the DB level for storage
efficiency, but the only thing that may cross between users is that performance
benefit — never read state, tags, notes, saved articles, or the fact that another
user subscribes to something. The app has multiple authenticated API surfaces
(tRPC, Wallabag, Google Reader, MCP, save extensions, OAuth 2.1) that must all
enforce the same authorization model. The server makes outbound HTTP requests to
user-influenced URLs and must never be usable to reach internal services.

---

## 1. Untrusted HTML sanitization — primary XSS defense

**Docs:** `src/server/html/CLAUDE.md` · **Code:** `src/server/html/`

Entry bodies, saved articles, and AI summaries are rendered with
`dangerouslySetInnerHTML`. The server-side sanitizer is the **sole** XSS gate.

- **Every HTML field rendered to a user must be sanitized on the write path
  (services layer), never on the client.** New render sinks
  (`dangerouslySetInnerHTML`) must render only already-sanitized content.
- **Never render feed-controlled text (titles, author names, feed names) as HTML.**
- **Bump `SANITIZER_VERSION` whenever sanitizer behavior changes** (see the html
  doc for the rule) and rebuild the worker bundle.
- The allowlist deliberately excludes `script`/`style`/`on*`/`form`/`base`/`meta`,
  restricts URL schemes, forces `rel=noopener`, and treats SVG/MathML as mXSS-prone.
  Changes here need a security review.

## 2. SSRF-safe outbound fetching

**Docs:** `src/server/http/CLAUDE.md` · **Code:** `src/server/http/` (`ssrf.ts`,
`fetch.ts`)

- **Any fetch of a user-influenced URL must go through `fetchWithSsrfProtection`.**
  Do not call `fetch`/`undici` directly on a URL that a user or feed can influence.
- The guard pins DNS to defeat rebinding, re-validates every redirect hop, blocks
  private/loopback/link-local/cloud-metadata ranges and all literal-IP encodings,
  rejects non-http schemes, and enforces size + timeout limits.
- Applies to: feed polling/discovery, WebSub hub subscribe, full-content/save
  fetches, and content-source plugins. The content-source plugins that fetch
  hardcoded public hosts (`plugins/github.ts`, `plugins/bluesky.ts`,
  `feed/arxiv.ts`, `feed/lesswrong.ts`, Google Docs/Drive) route through the guard
  too, so a future refactor that makes one of those hosts user-influenced can't
  silently regress into SSRF (#1265). Keep it that way; don't call `fetch`/`undici`
  directly on any content-source URL.

## 3. WebSub (feed push)

**Docs:** `src/server/feed/CLAUDE.md` · **Code:** `src/server/feed/websub.ts`,
`src/app/api/webhooks/websub/`

- Incoming content-distribution POSTs are authenticated by **HMAC over the raw
  request bytes**, with an algorithm allowlist and a timing-safe compare — keep it
  that way; never trust pushed content without verifying the signature.
- Hub URLs advertised by feeds are fetched through the SSRF guard. The weak
  `isPrivateHostname` check in `websub.ts` is only for our own configured callback
  URL — **do not reuse it for untrusted URLs.**

## 4. Sessions & authentication

**Docs:** `src/server/auth/CLAUDE.md` · **Code:** `src/server/auth/`

- Session cookie is `HttpOnly`, `Secure` (prod), `SameSite=Lax`; tokens are 32
  random bytes, SHA-256 hashed at rest, never stored raw. **Keep these flags.**
- Password change (and any credential change) must revoke other sessions
  (`revokeOtherUserSessions`).
- Password-accepting endpoints are rate-limited per-IP **and** per-account (the
  account bucket degrades to in-memory, not fully open, during a Redis outage).
- **OAuth sign-in is the only email-verification path**, so the shared OAuth
  processor (`src/server/auth/oauth/callback.ts`) **refuses to link or create an
  account from an unverified provider email** (`emailVerified` must be true).
  Apple id_tokens are claim-validated (iss/aud/exp) in `oauth/apple.ts`.

## 5. Token scopes & tRPC authorization

**Docs:** `src/server/auth/CLAUDE.md` (scopes), `src/server/CLAUDE.md` · **Code:**
`src/server/trpc/trpc.ts`, `src/server/trpc/routers/`

- **Authorization is fail-closed.** `protectedProcedure` is **session-only**; token
  access is explicit opt-in via `scopedProtectedProcedure(scope)`. New endpoints
  are token-inaccessible until they opt in — keep it that way.
- **Every resource read/mutation must be scoped to the authenticated user**
  (`WHERE user_id = …` or the `visible_entries` / `user_feeds` views). No fetching
  a resource by an id from input without a user predicate (IDOR).

## 6. OAuth 2.1 server & MCP auth

**Docs:** `src/server/oauth/CLAUDE.md` · **Code:** `src/server/oauth/`,
`src/app/oauth/`, `src/app/api/mcp/`

- PKCE mandatory and verified; auth codes single-use + expiry + client/redirect
  bound; `redirect_uri` exact-match allowlist; refresh-token rotation with reuse
  detection; client secrets hashed; RFC 8707 audience binding enforced at use.
- The consent POST re-validates scopes/redirect/client server-side — **never trust
  the form's scope field.** OAuth access tokens are accepted **only** at
  `/api/mcp` (audience-bound), not in the main tRPC/REST context.

## 7. Cross-user data isolation (shared content)

**Docs:** `src/server/CLAUDE.md` (Subscription Views, Entry Visibility, Compat API
Integer IDs) · **Code:** `src/server/services/`, `migrations/schema.sql` (views)

- Entries and feeds are shared rows; **per-user state (read/star/tags/notes/saved,
  subscription existence) must always be joined per-user.** Frontend reads go
  through `user_feeds` / `visible_entries`, which filter to the requesting user.
- Unread counts come from per-user denormalized counters, not scans of shared rows.
- AI summaries are keyed `(user_id, content_hash)`; narration is a shared cache of
  a deterministic transform of **public** content only.

## 8. Companion APIs (Wallabag, Google Reader, MCP, save extensions)

**Docs:** `src/server/auth/CLAUDE.md`, `src/server/CLAUDE.md` (Compat API Integer
IDs) · **Code:** `src/app/api/wallabag/`, `src/app/api/greader.php/`,
`src/server/wallabag/`, `src/server/google-reader/`, `src/server/mcp/`

- These require `reader:full-access` (or MCP scope) + signup confirmation and
  authenticate via hashed-token lookup (no string compare).
- Clients address entries/feeds by **integer serials stored in the DB**
  (`greader_item_id`, `greader_stream_id`, …). The serial↔UUID lookups are
  necessary because these protocols mandate integer IDs. **Every serial↔UUID
  resolver is scoped to the authenticated user** — `resolveWallabagEntry` /
  `resolveFeedStream`, and (since #1268) `greaderItemIdsToUuids` /
  `entryIdToWallabagId`, all seek through `visible_entries`/user predicates, so a
  resolved id is guaranteed visible to the caller. Keep it that way: a new
  resolver that reverses a client-supplied serial must take a `userId` and scope
  its lookup, never seek the shared `entries` table unscoped.

## 9. Webhooks & SSR

**Code:** `src/app/api/webhooks/email/mailgun/`, `src/app/(app)/`, `src/app/admin/`

- Mailgun webhook: HMAC-SHA256 signature + timestamp freshness window + Redis
  nonce replay protection. Keep all three.
- Server components validate the session on every request; **admin authorization is
  checked server-side on every admin procedure** (`adminProcedure`), never in the
  UI only.
- Post-auth redirect targets from query params must be sanitized to same-origin
  paths (`safeRedirectPath`) to prevent open redirects.
