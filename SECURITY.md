# Security-Critical Code Map

This is the index of the code where a mistake becomes a vulnerability (XSS, SSRF,
auth bypass, cross-user data leak) rather than a bug. **If you review or modify
anything listed here, treat the bold invariants as hard requirements** and read
the linked per-directory doc; the code comments carry the mechanics.

Reporting a vulnerability: email self@brendanlong.com. Do not open a public issue
for an unpatched vulnerability.

---

## Threat model

Feed and article content is **fully attacker-controlled** (anyone can publish a
feed a user subscribes to, or have a user save an arbitrary URL). Users are
**mutually untrusted**: entries and feeds are shared at the DB level for storage
efficiency, but nothing else may cross between users — not read state, tags,
notes, saved articles, or the fact that another user subscribes to something.
Every authenticated API surface (tRPC, Wallabag, Google Reader, MCP, save
extensions, OAuth 2.1) must enforce the same authorization model. The server
fetches user-influenced URLs and must never be usable to reach internal services.

---

## 1. Untrusted HTML — XSS

**Docs:** `src/server/html/CLAUDE.md` · **Code:** `src/server/html/`, `native/sanitizer/`

- **Every HTML field rendered to a user is sanitized in the services layer, on
  every read, never on the client.** New `dangerouslySetInnerHTML` sinks render
  only already-sanitized content; new read paths funnel through the services-layer
  chokepoints.
- **Never render feed-controlled text (titles, authors, feed names) as HTML.**
- Any change to the sanitizer's allow-lists or transforms needs a security review.
- **Keep the defense-in-depth headers** (`securityHeaders` in `next.config.ts`:
  anti-framing, `nosniff`, `Referrer-Policy`, HSTS in production).
- **CSP is the backstop** (`src/server/http/csp.ts`, applied in `src/proxy.ts`;
  directive rationale in `csp.ts`). Dynamic routes get a strict per-request nonce
  policy. The statically prerendered `(public)` pages (`isPublicStaticPath`) can't
  carry a nonce and get a relaxed policy, so **they must render zero
  user-supplied HTML**: anything rendering untrusted HTML lives under `(spa)`.
- **The native app's reader view** (`kmp/androidApp/.../reader/`, its document
  from `kmp/shared/.../reader/ReaderDocument.kt`) renders the same
  sanitized HTML in a WebView beside the app's tokens. **The only scripts in that
  document are our bundled `scroll-detect.js` and `narration.js`**; its CSP
  (`ReaderDocument.kt`) allows no fetch/XHR/WebSocket, `base`, or form targets.
  Allow-listed embeds run only in their sandboxed cross-origin frames. No file or
  content access; the one message channel is limited to the asset origin's main
  frame, the app reads only layout, narration text and taps from it, and calls
  back only `lionNarration.highlight(number|null, boolean)`,
  `lionNarration.selectedParagraph()` (read as an integer or null) and
  `window.scrollTo` with numbers of its own. Every
  navigation leaves for the browser. Header text (title, byline) enters only via
  `escapeHtml`, and the title links to the entry only when it's http(s) (`webUrl`,
  which also gates the link menu, Open original and Share). Loosening any of this
  needs a security review.
- **The account export's pages** (`src/server/services/library-export.ts`) open
  from disk with no CSP behind them. Bodies are only the services layer's
  sanitized output, every other field goes through `escapeHtml`, and a URL becomes
  an href only if it's http(s).
- **The native app's share target** (`ShareActivity`) is exported, so any app can
  hand it a link to save. That stays bounded because only http(s) links are
  taken, the server fetches through the SSRF guard and sanitizes on read, and
  nothing goes back to the caller. **It must never forward the incoming intent or
  its extras.**
- **Analytics reports a closed vocabulary, never a URL** (`src/lib/analytics/`;
  no third-party script). **Adding a route to `paths.ts` is a security
  decision** — ask what that URL and title can contain.

## 2. SSRF

**Docs:** `src/server/http/CLAUDE.md` · **Code:** `src/server/http/ssrf.ts`

- **Every fetch of a user-influenced URL goes through `fetchWithSsrfProtection`**,
  never `fetch`/`undici` directly. No caller can opt out of its per-hop checks.
- **The guard itself rejects non-http(s) schemes** on the initial URL and every
  redirect hop (`assertAllowedScheme`), rather than leaving it to the underlying fetch.
- Content-source plugins that fetch hardcoded public hosts (GitHub, Bluesky, arXiv,
  LessWrong, Google Docs/Drive) use the guard too, so a refactor that makes a host
  user-influenced can't regress into SSRF (#1265). Keep it that way.

## 3. WebSub

**Code:** `src/server/feed/websub.ts`, `src/app/api/webhooks/websub/`

- **Content pushes are authenticated by HMAC over the raw request bytes** (algorithm
  allowlist, timing-safe compare). Never trust pushed content without it.
- Hub URLs are fetched through the SSRF guard. **The weak `isPrivateHostname` in
  `websub.ts` is only for our own callback URL — never reuse it for untrusted URLs.**

## 4. Sessions & authentication

**Docs:** `src/server/auth/CLAUDE.md` · **Code:** `src/server/auth/`

- **The session cookie stays `HttpOnly`, `Secure` (prod), `SameSite=Lax`**; tokens
  are 32 random bytes, stored only as SHA-256 hashes.
- **Any credential change revokes the user's other sessions** — password change,
  and linking/unlinking a social provider (`src/server/services/oauth-accounts.ts`
  says why a failed revoke doesn't undo the change). The one exception is the
  email-match link inside `processOAuthCallback`, an ordinary sign-in; it says why.
- **Setting or changing the password revokes the user's Wallabag tokens** in the
  same transaction. Token issuance first takes a share lock on the `users` row
  (`lockUserAgainstCredentialChange`) so a racing grant can't leave a live token —
  keep that lock order.
- **A long-lived authenticated connection re-checks its credential periodically**
  and closes once it's revoked or expired, as the SSE stream does on every heartbeat
  (`src/app/api/v1/events/route.ts`).
- **Password endpoints are rate-limited per IP and per account**, and verify through
  `verifyEmailPassword`, which pays the argon2 cost even for a missing user (#1267).
  **Never add an early return that skips argon2.**
- **OAuth sign-in is the only email-verification path**, so `processOAuthCallback`
  **refuses to link or create an account from an unverified provider email**.
- **Keep the Apple id_token signature check** (`oauth/apple.ts`): nothing else
  verifies the signature.
- **OAuth `state` is bound to the initiating browser** by an `HttpOnly` cookie the
  callback routes require (`oauth/state-cookie.ts`, fail-closed; #1263). The Redis
  state alone doesn't tie the callback to a browser. Google's `extension-save` mode
  is the one exemption (the callback route says why).

## 5. Token scopes & tRPC authorization

**Docs:** `src/server/auth/CLAUDE.md` · **Code:** `src/server/trpc/trpc.ts`

- **Authorization is fail-closed.** `protectedProcedure` is session-only; token
  access is opt-in via `scopedProtectedProcedure(scope)`.
- **`scopedUnconfirmedProcedure` is only for the caller's own account/confirmation
  state (`auth.me`), never user content**, or tokens would bypass the signup
  confirmation gate.
- **Every read and mutation is scoped to the authenticated user** (`user_id`
  predicate or the `visible_entries`/`user_feeds` views). Never fetch by an input id
  without a user predicate (IDOR).

## 6. OAuth 2.1 server & MCP auth

**Docs:** `src/server/oauth/CLAUDE.md` · **Code:** `src/server/oauth/`,
`src/app/(spa)/oauth/`, `src/app/api/mcp/`

- PKCE mandatory; auth codes single-use, expiring, and client/redirect bound;
  `redirect_uri` exact-match; refresh rotation with reuse detection; client secrets
  hashed; RFC 8707 audience enforced at use.
- **The consent POST re-validates scopes/redirect/client server-side — never trust
  the form.**
- **OAuth access tokens are accepted only by the resource their audience names.**
  **Only the pinned first-party app client (`app-client.ts`) may be minted the
  `/api/v1` audience** — dynamic registration lets any client request any scope, so
  the audience is the gate.
- The keys published in `/.well-known/assetlinks.json` (`ANDROID_APP_CERT_SHA256`,
  `ANDROID_DEBUG_APP_CERT_SHA256`) decide which installed apps receive that client's
  codes; the debug redirect path is accepted only while it has a published key.
  **List only keys we control — never Android's default debug key**, whose password
  is public.
- **Never hand a code to an app by package name** (an `intent:` link, a button on
  the callback page): any app can claim a package name the real app isn't installed
  under. The one exception is a loopback issuer (`isLoopbackUrl`) in local
  development, which accepts the debug redirect without a key and hands it to the
  debug build (`OpenInDebugApp`).

## 7. Cross-user data isolation

**Docs:** `src/server/CLAUDE.md` · **Code:** `src/server/services/`, `migrations/schema.sql`

- **Per-user state (read/star/tags/notes/saved, subscription existence) is always
  joined per user**; entries and feeds are shared rows.
- **Entry visibility is gated at insert time**: `user_entries` rows are created only
  for content currently in a feed when the user subscribes or a fetch runs, never
  for older content.
- **Collection membership is a visibility arm, so adding an article must never grant
  access**: `addEntriesToCollection` inserts only articles already in the user's
  `visible_entries`, a collection id is accepted only if the user owns it, and the
  `(subscription_id, user_id)` foreign key stops a membership from naming another
  user's collection (`services/collections.ts`, the `collection_entries` foreign keys).
- AI summaries are keyed `(user_id, content_hash)`. Narration is a shared cache of a
  deterministic transform of public content, so **only a failure the content causes
  may be recorded on a `narration_content` row** — never one from a user's own key
  or model (`narrationFailureScope`, #1755) — and **a user-picked model's output is
  cached under a key bound to that user and model** (`narrationContentHash`).

## 8. Companion APIs (Wallabag, Google Reader, MCP, save extensions)

**Docs:** `src/server/CLAUDE.md` (Compat API Integer IDs) · **Code:**
`src/app/api/wallabag/`, `src/app/api/greader.php/`, `src/server/wallabag/`,
`src/server/google-reader/`, `src/server/mcp/`

- These require `reader:full-access` (or MCP scope) plus signup confirmation, and
  authenticate by hashed-token lookup.
- **The secretless Wallabag token endpoint is pinned to the `wallabag` client_id**
  (`WALLABAG_CLIENT_ID`): it shares token tables with the OAuth server, so honoring a
  caller-supplied client_id would let it rotate or mint another client's tokens.
- **Every resolver that reverses a client-supplied integer id takes a `userId` and
  scopes its lookup** (#1268) — never seek the shared `entries` table unscoped.

## 9. Webhooks & admin

**Code:** `src/app/api/webhooks/email/mailgun/`, `src/app/(spa)/admin/`

- Mailgun webhook: HMAC-SHA256 signature + timestamp freshness + Redis nonce replay
  protection. Keep all three.
- **Admin authorization is checked server-side on every admin procedure**
  (`adminProcedure`), never only in the UI.
- Post-auth redirect targets from query params go through `safeRedirectPath`
  (same-origin paths only).

## 10. Unauthenticated paid work (demo narration)

**Code:** `src/app/api/prerecorded-speech/`, `src/server/services/prerecorded-speech.ts`,
`src/server/services/demo-narration.ts`

- `/api/prerecorded-speech/:key` has no session yet can synthesize speech on the
  server's key, so **it only synthesizes keys in the server-built demo catalog,
  never accepts text, voice, or model from the request, and never synthesizes a
  chunk without caching it on disk** (which bounds synthesis to once per chunk per
  machine start; `prerecorded-speech.ts` covers the failure backoff).
