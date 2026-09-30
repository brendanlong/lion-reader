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

**Docs:** `src/server/html/CLAUDE.md` · **Code:** `src/server/html/`,
`native/sanitizer/` (the Rust sanitizer — allow-lists and transforms live there)

Entry bodies, saved articles, and AI summaries are rendered with
`dangerouslySetInnerHTML`. The server-side sanitizer is the **sole** XSS gate.

- **Every HTML field rendered to a user must be sanitized in the services layer,
  never on the client.** Entry content is sanitized **on every read** (raw HTML is
  stored; see issue #1282) via `sanitizeEntryContentFamily`/`sanitizeEntryHtml`.
  New render sinks (`dangerouslySetInnerHTML`) must render only already-sanitized
  content, and new read paths must funnel through the services-layer chokepoints.
- **Never render feed-controlled text (titles, author names, feed names) as HTML.**
- Sanitization is per-read, so a rules change in `native/sanitizer/` takes effect
  on the next read everywhere after a deploy — rebuild the native module
  (`pnpm build:native`). There is no version constant to bump. See the html doc.
- The allowlist deliberately excludes `script`/`style`/`on*`/`form`/`base`/`meta`,
  restricts URL schemes, forces `rel=noopener`, and treats SVG/MathML as mXSS-prone.
  Changes here need a security review.
- **Defense-in-depth headers**: `securityHeaders` in `next.config.ts` sets
  `X-Frame-Options`, `X-Content-Type-Options: nosniff`, `Referrer-Policy`, and
  (prod) HSTS. The **Content-Security-Policy** is set in `src/proxy.ts` with
  the policies built in `src/server/http/csp.ts`, and is **two-tier** (#1359):
  - **Strict nonce'd policy (the default, on every dynamic route)**: a random
    per-request nonce, threaded to the inline `<script>`s in
    `src/app/root-document.tsx` (and next-themes) via the `x-nonce` request
    header, so an injected `<script>` (or inline event handler) that survives a
    sanitizer regression is blocked by the browser instead of executing — the
    sanitizer is the primary XSS gate, the CSP is the backstop.
  - **Relaxed static policy (only the statically-prerendered public pages —
    `isPublicStaticPath` in `src/proxy.ts`)**: prerendered HTML can't carry a
    nonce. **Invariant: these pages must render zero user-supplied HTML** —
    demo articles are dev-authored constants, and the auth forms render user
    input only as escaped React text. Any page that renders untrusted HTML must
    live under the `(spa)` route group (strict CSP); adding untrusted HTML to a
    `(public)` page re-triggers the strict-CSP requirement and needs a security
    review.

  Directive rationale lives in `csp.ts`.

- **The native app's reader view** (`kmp/androidApp/.../reader/`) renders the
  same sanitized HTML (article bodies and AI summaries) in a WebView next to
  the app's tokens. **Invariant: the only script in the reader document is our
  bundled `scroll-detect.js`** — its CSP (`ReaderHtml.kt`) allows that one
  file, no fetch/XHR/WebSocket, no `base` or form targets. Allow-listed embeds run their own scripts in their
  sandboxed cross-origin frames, as on the web. No file or content access, no
  bridge beyond one message channel limited to the asset origin's main frame,
  and every navigation leaves for the browser. The article header's feed text
  (title, byline) enters the document only through `escapeHtml`. Loosening any
  of that needs a security review.
- **The native app's share target** (`ShareActivity`) is exported, so any app
  can hand it a link to save, with no confirmation beyond the dialog. That's
  the usual share-target trade-off and stays bounded because only http(s)
  links are taken, the server fetches them through the SSRF guard and
  sanitizes what it stores, and nothing goes back to the caller. It must never
  forward the incoming intent or its extras.

- **Analytics reports a closed vocabulary, never a URL**
  (`src/lib/analytics/`): we load **no third-party analytics script**, and every
  reported path is a constant looked up in `paths.ts`, so `AnalyticsPath` is
  closed by construction and an unmapped route reports nothing. **Adding a route
  there is a security decision** — ask what that URL and title can contain. The
  rationale (and the matching referrer rule) is in the file headers of
  `paths.ts`, `beacon.ts`, and `goatcounter.ts`.

## 2. SSRF-safe outbound fetching

**Docs:** `src/server/http/CLAUDE.md` · **Code:** `src/server/http/` (`ssrf.ts`,
`fetch.ts`)

- **Any fetch of a user-influenced URL must go through `fetchWithSsrfProtection`.**
  Do not call `fetch`/`undici` directly on a URL that a user or feed can influence.
- The guard pins DNS to defeat rebinding, re-validates every redirect hop, blocks
  private/loopback/link-local/cloud-metadata ranges and all literal-IP encodings,
  rejects non-http(s) schemes via an explicit allowlist enforced on the initial URL
  and every redirect hop (not left to the underlying fetch), and enforces size +
  timeout limits.
- Applies to: feed polling/discovery, WebSub hub subscribe, full-content/save
  fetches, and content-source plugins. The content-source plugins that fetch
  hardcoded public hosts (`plugins/github.ts`, `plugins/bluesky.ts`,
  `plugins/arxiv.ts`, `feed/lesswrong.ts`, Google Docs/Drive) route through the guard
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
  (`revokeOtherUserSessions`). Linking and unlinking a social provider counts —
  each adds or removes a way to sign in (`src/server/services/oauth-accounts.ts`,
  which also says why a failed revoke doesn't undo the change). The one
  deliberate exception is the email-match link inside `processOAuthCallback`,
  which is an ordinary sign-in; it says why at the branch.
- Setting or changing the password also revokes the user's Wallabag tokens,
  which the password grant mints from it, in the same transaction as the
  password write. Token issuance takes a share lock on the `users` row first
  (`lockUserAgainstCredentialChange`), so a refresh or password grant racing
  the change can't leave a live token behind — keep that lock order.
- Password-accepting endpoints are rate-limited per-IP **and** per-account (the
  account bucket degrades to in-memory, not fully open, during a Redis outage).
- Password-accepting endpoints (tRPC `auth.login`, Google Reader `ClientLogin`,
  Wallabag password grant) verify via `verifyEmailPassword`
  (`src/server/auth/password.ts`), which runs a decoy `argon2.verify` for a
  missing/passwordless user so response timing can't be used to enumerate valid
  emails (#1267). **Don't reintroduce an early return that skips argon2.**
- **OAuth sign-in is the only email-verification path**, so the shared OAuth
  processor (`src/server/auth/oauth/callback.ts`) **refuses to link or create an
  account from an unverified provider email** (`emailVerified` must be true).
  Apple id_tokens are verified in `oauth/apple.ts` — signature against Apple's
  JWKS **and** iss/aud/exp. **Keep the signature check**: the OAuth client
  re-validates the claims but deliberately skips the signature for tokens read
  straight off the token endpoint, so nothing else covers a forged id_token.
- **OAuth `state` is bound to the initiating browser** to stop login CSRF /
  session fixation (#1263): generating an auth URL sets a short-lived `HttpOnly`
  state cookie (`oauth/state-cookie.ts`), and the browser-facing callback routes
  (`src/app/api/v1/auth/oauth/*/callback`) require it to equal the returned
  `state` (`oauthStateCookieMatches`, fail-closed on a missing cookie). Apple's
  form_post is a cross-site POST, so its cookie is `SameSite=None; Secure` (Lax
  would be withheld); Google/Discord stay `SameSite=Lax`. **Keep this check** — the
  Redis `state` lookup alone does not tie the callback to any browser. (Google's
  `extension-save` mode is exempt — its URL is built in a Server Component that
  can't set cookies, and it re-auths an already-logged-in user, not a login; see
  `src/server/auth/CLAUDE.md`.)

## 5. Token scopes & tRPC authorization

**Docs:** `src/server/auth/CLAUDE.md` (scopes), `src/server/CLAUDE.md` · **Code:**
`src/server/trpc/trpc.ts`, `src/server/trpc/routers/`

- **Authorization is fail-closed.** `protectedProcedure` is **session-only**; token
  access is explicit opt-in via `scopedProtectedProcedure(scope)`. New endpoints
  are token-inaccessible until they opt in — keep it that way.
- `scopedUnconfirmedProcedure` also opts in but skips the signup-confirmation
  gate; **use it only for the caller's own account/confirmation state (today
  `auth.me`), never for user content**, or tokens would bypass the ToS/EU gate.
- **Every resource read/mutation must be scoped to the authenticated user**
  (`WHERE user_id = …` or the `visible_entries` / `user_feeds` views). No fetching
  a resource by an id from input without a user predicate (IDOR).

## 6. OAuth 2.1 server & MCP auth

**Docs:** `src/server/oauth/CLAUDE.md` · **Code:** `src/server/oauth/`,
`src/app/(spa)/oauth/`, `src/app/api/mcp/`

- PKCE mandatory and verified; auth codes single-use + expiry + client/redirect
  bound; `redirect_uri` exact-match allowlist; refresh-token rotation with reuse
  detection; client secrets hashed; RFC 8707 audience binding enforced at use.
- The consent POST re-validates scopes/redirect/client server-side — **never trust
  the form's scope field.** OAuth access tokens are accepted **only** by the
  resource their audience names: `/api/mcp` for MCP clients, and the main
  tRPC/REST/SSE surface (`/api/v1` audience) for the first-party native app's
  client alone (`src/server/oauth/app-client.ts`, `src/server/auth/app-token.ts`).
  **Only that pinned client may be minted the `/api/v1` audience** — dynamic
  registration lets any client request any scope, so the audience is the gate.
- The signing keys published in `/.well-known/assetlinks.json`
  (`androidAppConfig`, from `ANDROID_APP_CERT_SHA256` /
  `ANDROID_DEBUG_APP_CERT_SHA256`) decide which installed apps receive that
  client's authorization codes. **List only keys we control** — never
  Android's default debug key, whose password is public.

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
- The Wallabag token endpoint is secretless, so it is **pinned to the
  `wallabag` client_id** (`WALLABAG_CLIENT_ID`): it shares token tables with the
  OAuth 2.1 server, and honoring a caller-supplied client_id would let it rotate
  another client's refresh token or mint tokens in that client's name.
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

**Code:** `src/app/api/webhooks/email/mailgun/`, `src/app/(spa)/(app)/`, `src/app/(spa)/admin/`

- Mailgun webhook: HMAC-SHA256 signature + timestamp freshness window + Redis
  nonce replay protection. Keep all three.
- Server components validate the session on every request; **admin authorization is
  checked server-side on every admin procedure** (`adminProcedure`), never in the
  UI only.
- Post-auth redirect targets from query params must be sanitized to same-origin
  paths (`safeRedirectPath`) to prevent open redirects.
