# Lion Reader Design Document

## Table of Contents

1. [System Architecture](#system-architecture)
2. [Database Design](#database-design)
3. [Authentication](#authentication)
4. [Feed Processing](#feed-processing)
5. [Real-time Updates](#real-time-updates)
6. [API Design](#api-design)
7. [Frontend Architecture](#frontend-architecture)
8. [MCP Server](#mcp-server)
9. [Infrastructure](#infrastructure)
10. [Observability](#observability)
11. [Testing Strategy](#testing-strategy)

### Architecture Diagrams (D2)

Visual architecture diagrams are available in `docs/diagrams/`:

- **[frontend-data-flow.d2](diagrams/frontend-data-flow.d2)** - Delta-based state management with React Query
- **[backend-api.d2](diagrams/backend-api.d2)** - tRPC routers, services layer, and database
- **[feed-fetcher.d2](diagrams/feed-fetcher.d2)** - Background job queue and feed processing pipeline
- **[sse-cache-updates.d2](diagrams/sse-cache-updates.d2)** - SSE event flow from backend to frontend cache updates

To render these diagrams, use the [D2 CLI](https://d2lang.com/) or [D2 Playground](https://play.d2lang.com/).

---

## System Architecture

### High-Level Overview

```
                                    ┌──────────────────┐
                                    │  Mailgun         │
                                    │  Email Webhooks  │
                                    └────────┬─────────┘
                                             │ webhook
┌─────────────────┐                          │
│   WebSub Hubs   │                          │
└────────┬────────┘                          │
         │ push                              │
         ▼                                   ▼
┌─────────────────────────────────────────────────────────────┐
│                        Load Balancer                         │
└─────────────────────────────┬───────────────────────────────┘
                              │
        ┌─────────────────────┼─────────────────────┐
        ▼                     ▼                     ▼
┌───────────────┐     ┌───────────────┐     ┌───────────────┐
│  App Server   │     │  App Server   │     │  App Server   │
│  ┌─────────┐  │     │               │     │               │
│  │ Next.js │  │     │   (same)      │     │   (same)      │
│  │ tRPC    │  │     │               │     │               │
│  │ SSE     │  │     │               │     │               │
│  └─────────┘  │     │               │     │               │
└───────┬───────┘     └───────┬───────┘     └───────┬───────┘
        │                     │                     │
        └──────────┬──────────┴──────────┬──────────┘
                   │                     │
   ┌───────────────┤                     │
   │               │                     │
   │  Separate Fly process groups (see [processes] in fly.toml):
   │               │                     │
   │  ┌─────────────────┐   ┌──────────────────┐
   │  │  Worker (min 1) │   │  Discord Bot     │
   │  │  feed fetching, │   │  save via emoji  │
   │  │  background jobs│   │  reactions or DM │
   │  └────────┬────────┘   └────────┬─────────┘
   │           │                     │
   ▼           ▼                     ▼
   └──────────►┤                     │
               ▼                     ▼
           ┌─────────────┐       ┌─────────────┐
           │  Postgres   │       │    Redis    │
           │             │       │  - pub/sub  │
           │  - all data │       │  - cache    │
           │  - job queue│       │  - sessions │
           └─────────────┘       │  - rate lim │
                                 └─────────────┘

┌─────────────────────────────────────────────────────────────┐
│                      MCP Server (Optional)                   │
│  Exposes Lion Reader to AI assistants via HTTP + stdio       │
│  Uses same services layer as tRPC routers                    │
└─────────────────────────────────────────────────────────────┘
```

The **app**, **worker**, and **discord** processes are separate Fly.io process
groups (`[processes]` in `fly.toml`), each independently scaled — the worker is
not embedded in the app servers.

### Design Principles

1. **Stateless app servers**: All state in Postgres/Redis, enabling horizontal scaling
2. **Efficient data sharing**: Feed/entry data deduplicated across users
3. **Privacy by default**: Users only see entries fetched after they subscribed
4. **Graceful degradation**: Handle misbehaving feeds, rate limits, and failures
5. **Observable**: Comprehensive logging, metrics, and error tracking

### Component Responsibilities

| Component         | Responsibilities                                      |
| ----------------- | ----------------------------------------------------- |
| **App Server**    | HTTP API, SSE connections                             |
| **Worker**        | Background job execution (feed fetching)              |
| **Discord Bot**   | Save articles via emoji reactions or DMs in Discord   |
| **Postgres**      | Persistent storage, job queue (pg-boss style)         |
| **Redis**         | Session cache, rate limiting, pub/sub for real-time   |
| **Email Service** | Inbound email processing for newsletter subscriptions |

---

## Database Design

### ID Strategy

All primary keys use **UUIDv7**, which provides:

- Global uniqueness without coordination
- Time-ordered (roughly chronological, good for pagination)
- Better B-tree index performance than UUIDv4 (sequential inserts)
- Extractable timestamp if needed

### Key Tables

The schema is defined in `migrations/` directory. Key tables:

- **users** - User accounts with email, password hash, OAuth links
- **sessions** - Session tokens with expiry and revocation
- **feeds** - Canonical feed data (URL, metadata, fetch state) - shared across users for efficiency
- **entries** - Feed entries with content and timestamps
- **subscriptions** - User-to-feed relationships with subscription time
- **user_entries** - Per-user read/starred state for entries
- **jobs** - Background job queue for feed fetching
- **websub_subscriptions** - WebSub push subscription state
- **websub_hub_stats** - Per-hub tally of how new articles first reached us (hub push vs. backup poll), for spotting silently-broken hubs
- **ingest_addresses** - Per-user email addresses for newsletter ingestion
- **narration_content** - Cached LLM-processed narration text
- **entry_summaries** - Cached AI-generated article summaries
- **tags** / **subscription_tags** - User-created tags with many-to-many subscription mapping
- **api_tokens** - Scoped API tokens for external access
- **invites** - Invite codes for invite-only registration mode
- **blocked_senders** - Blocked email senders for newsletter ingestion
- **opml_imports** - OPML import job tracking
- **oauth_accounts** / **oauth_clients** / **oauth_authorization_codes** / **oauth_access_tokens** - OAuth provider links and OAuth server implementation

### Database Views

Views simplify queries by abstracting the feeds/subscriptions join:

- **user_feeds** - Subscriptions with feed metadata merged (including the trigger-maintained `unread_count`), using subscription ID as the primary key. Display-only (subscription list surfaces); link/ownership/scoping checks must query `subscriptions` directly
- **visible_entries** - Entries with visibility rules applied, including subscription context (via `user_entries.subscription_id`)

### Key Design Decisions

**Entry Visibility**: Visibility is enforced at query time by the `visible_entries` view, which requires a `user_entries` row to exist for the `(user, entry)` pair AND that the entry is either from an active subscription (`subscription.unsubscribed_at IS NULL`), is starred, or is a saved article (saved articles live in a per-user feed with no subscription row, so their `user_entries` row alone grants visibility). Each `user_entries` row links to its subscription through the denormalized `user_entries.subscription_id` column (see **Subscription attribution** below); the view joins `subscriptions` directly on it and emits exactly one row per `(user, entry)`. The predicate is fail-closed: the saved-article arm gates on the entry **type**, never on `subscription_id IS NULL`, so a NULL-attributed row is hidden unless starred/saved. The existence of the `user_entries` row is the durable record of visibility.

The `user_entries` rows are created outside the view at:

- **Subscribe time**: for a feed whose cached entries are current, rows are inserted for entries with `entries.last_seen_at >= feeds.last_entries_updated_at` — so a new subscriber sees current feed contents but not arbitrarily old ones (disappeared entries fall below `last_entries_updated_at` and stay excluded). See `createSubscription` in `src/server/services/subscriptions.ts`. The comparison is `>=`, not `=`, to also cover entries a **WebSub hub pushed since the last poll**: a push stamps `last_seen_at = pushTime` but deliberately leaves `last_entries_updated_at` at the last poll (and no longer bumps `last_fetched_at`), so pushed entries sit above `last_entries_updated_at` and strict equality would hide them — a push-active feed's new subscriber would see an **empty feed** (issue #1078). For a non-WebSub feed nothing is ever stamped above `last_entries_updated_at`, so `>=` is exactly `=` and behavior is unchanged.

  When the feed is **stale** (`shouldRefetchOnSubscribe`: a WebSub feed whose last real poll has aged past the cache window, or a normal feed past its poll cadence), the cached entries can't be trusted as the current set, so `subscriptions.create` **skips the synchronous populate** (`createSubscription({ skipInitialPopulate })`) and instead schedules an **immediate forced background refresh** (`scheduleFeedRefreshNow`). That runs the ordinary `handleFetchFeed` in the worker with `forceReprocess`: it fetches unconditionally, re-stamps every current entry to one generation, and — because the subscription row already exists — fans out `user_entries` to the new subscriber from ground truth even when nothing changed, excluding anything the publisher removed since a push. Keeping the fetch on the worker (not the request path) means the job queue's per-feed single-flight coalesces concurrent subscribes into one fetch and merges with any pending poll; the subscriber sees entries fill in via SSE a moment later, exactly as a brand-new feed does. The one-shot `forceReprocess` flag lives on the feed's job payload and is consumed on the next successful run so ordinary polls don't keep reprocessing.

- **Fetch time**: when a feed fetch changes the feed (new/updated/disappeared entries), rows are created for that feed's active subscribers. The fanout is **state-driven**: it passes _every_ entry ID in the current fetch (not just the newly-created ones) to the idempotent `createUserEntriesForFeed` (`ON CONFLICT DO NOTHING`). This self-heals an entry that a previous fetch inserted but failed to fan out (e.g. the worker crashed in between): on the retry that entry matches by `content_hash` and is reported `isNew:false`, so an event-driven fanout would skip it forever, but the state-driven fanout re-covers it on the next fetch with any activity. See `createUserEntriesForFeed` / `processEntries` in `src/server/feed/entry-processor.ts`. A deliberate consequence: an entry that a feed drops and later re-lists becomes visible to existing subscribers who weren't subscribed when it was last current — this is consistent with the subscribe-time rule (any subscriber sees whatever is currently in the feed) and is not a privacy regression, because the fanout only ever covers entries **present in the current fetch** (public, current feed contents), never entries that predate and are absent from it.

The older `entry.fetched_at >= subscription.subscribed_at` rule was a one-time backfill applied in migration `0007_user_entries_visibility.sql`; it is **not** enforced by the view. This insert-time gating is what prevents information leakage when users subscribe to feeds that may have contained private content before they subscribed.

**Subscription attribution**: Each `user_entries` row carries a denormalized `subscription_id` — its single owning subscription, or NULL for saved/uploaded articles (which live in a per-user feed with no subscription row) — and a copy of `entries.is_spam` (immutable after insert). This is the sole link from an entry to a subscription; `visible_entries` and every subscription/tag filter resolve through it. It stays consistent three ways: the bulk insert paths (feed fanout, subscribe-time populate) set it inline; the `user_entries_fill_denormalized` BEFORE INSERT trigger fills it — plus `is_spam` and the timeline sort key — for every other insert; and the feed-merge job re-stamps rows from an absorbed subscription to the survivor, which also carries attribution across multi-hop redirect chains. The FK is `ON DELETE SET NULL`, so read/star state survives even a hard subscription delete. (This replaced an earlier `subscription_feeds` junction table that mapped subscriptions to feed IDs; migrating to the stamped column removed the junction and the `COUNT(DISTINCT)`/`DISTINCT ON` dedup it forced — see issue #1117.)

**Unread counts**: Unread badge counts are denormalized onto four trigger-maintained columns — `subscriptions.unread_count` / `starred_unread_count` and `users.saved_unread_count` / `starred_unread_count` — with **spam permanently excluded** (`is_spam` is immutable, so a row's contribution never changes out from under a counter). The `user_entries_counters_*` AFTER-STATEMENT triggers (transition tables, one grouped update per statement) maintain them on every insert/update/delete, including read/star flips and the merge re-stamp (which moves counts between subscriptions). Badges are then O(subscriptions) arithmetic rather than entry scans: subscription = `unread_count`; tag / uncategorized = SUM over the tag's / untagged **active** subscriptions; saved / starred = the users-row counters; and `all` = SUM(`unread_count`) over active subscriptions + `saved_unread_count` + SUM(`starred_unread_count`) over **inactive** subscriptions. That last term is the starred-orphans correction (starred entries stay visible after unsubscribe) and is derived at read time, so unsubscribe / resubscribe / merge need no counter writes. Only the generic filtered counts (`countEntries` scoped path, `countTotalEntries`, used by MCP/Wallabag) still scan `visible_entries`. The daily `reconcile_counters` singleton job recomputes all four from ground truth, repairs any drift, and logs a fix at error level (a fix means a trigger bug to investigate). See `src/server/services/counts.ts` and `reconcile-counters.ts`.

**Soft Deletes**: Subscriptions use `unsubscribed_at` for soft delete, allowing users to resubscribe and maintain their read state.

**Content Change Detection**: Entries store a `content_hash` to detect when content changes on the source feed. Updated content overwrites the previous version.

**Read/Star Idempotency**: `user_entries` carries per-field change timestamps (`read_changed_at`, `starred_changed_at`), and state mutations accept a `changedAt` and only apply when newer than the stored timestamp. This makes conflicting updates from multiple clients (tabs, MCP, offline sync replaying old actions) resolve to the newest user intent instead of last-write-wins.

**Row Written vs. Value Flipped** (issue #1118): a same-value re-assert (marking an already-read entry read — the common Google Reader/Wallabag resync pattern) still **writes** the row, because the `*_changed_at` watermark must keep advancing or an older conflicting update could later win (redundant `read@T2` must beat a late-arriving `unread@T3` when `T3 < T2`). But user-facing side effects key off the value actually **flipping**: `markEntriesRead`/`updateEntryStarred` capture the pre-update value in the UPDATE itself (a `user_entries AS prev` self-join in `FROM`, avoiding a pre-SELECT's TOCTOU window) and run the unread-count aggregation + `entry_state_changed` SSE publish only for flips. Their returned `counts` is absent on a pure re-assert; clients treat that as "counts unchanged".

The two roles are split across **two columns**, so "row touched" and "meaningfully changed" have distinct timestamps (issue #1118 Part 2). `user_entries.read_changed_at` / `starred_changed_at` are the **last-writer-wins conflict watermarks** and advance on _every_ accepted write (including a same-value re-assert), because that is what makes a late replay lose. `user_entries.updated_at` is the **"meaningful change" timestamp** and moves **only on a real flip** — the mark-read/star UPDATEs bump it with `CASE WHEN prev.<col> <> <target> THEN now ELSE ue.updated_at END`. Everything that drives delta-sync visibility keys off `updated_at` — the `sync.events` cursor and Wallabag `since`, both via `visible_entries.updated_at = GREATEST(entries.updated_at, user_entries.updated_at)` — so a re-assert advances the watermark (LWW stays correct) but does **not** re-deliver the entry to offline/polling clients. This is safe because `updated_at` reflects the last _meaningful_ change: any client whose cursor predates that change already gets the current state, and a re-assert changes nothing it needs. Rather than add a separate `meaningful_updated_at` column, we gate the existing `updated_at` — it was already purely a delta-sync visibility timestamp, never a watermark, so no migration or view change is needed. (`markAllEntriesRead` filters to `read = false` rows, so it only ever touches genuine flips and bumps `updated_at` unconditionally.) The same "don't churn on a non-meaningful write" rule already covers feeds: a content re-fetch with an unchanged `content_hash` doesn't bump `entries.updated_at` (issue #1084). Subscription re-saves with identical settings are the remaining candidate to bring under this lens (issue #1118 Part 3).

**UUIDv7 Ordering**: Since UUIDv7 is time-ordered, `id` doubles as a roughly-chronological tiebreaker: keyset pagination breaks ties on `id DESC` and the insert locality keeps B-tree writes sequential. It is **not** the timeline sort key — the entries timeline sorts by `COALESCE(published_at, fetched_at)` (denormalized onto `user_entries.published_or_fetched_at`, see below), not by `id`, because publish order and insert order diverge.

**Timeline Sort Key Denormalization**: The timeline list query filters on `user_entries.user_id` but sorts by `COALESCE(entries.published_at, entries.fetched_at)`. Because filter and sort columns lived on different tables, no single index could cover both. Since that COALESCE value is immutable per entry, it is denormalized onto `user_entries.published_or_fetched_at` and indexed as `(user_id, published_or_fetched_at DESC, entry_id DESC)`, letting the planner serve the filter + sort from one index with LIMIT pushdown. Hot insert paths populate it inline; a `BEFORE INSERT` trigger backfills it for any caller that omits it.

---

## Authentication

### Strategy

Custom auth using battle-tested primitives:

- **`arctic`**: Lightweight OAuth library for Google/Apple/Discord
- **`argon2`**: Password hashing
- **Custom session management**: Token-based, stored in Postgres with Redis cache

### OAuth Providers

Lion Reader supports multiple OAuth providers for sign-in:

| Provider    | Scopes                       | Notes                                                      |
| ----------- | ---------------------------- | ---------------------------------------------------------- |
| **Google**  | `openid`, `email`, `profile` | Optional `documents.readonly` for Google Docs access       |
| **Apple**   | `name`, `email`              | Uses form_post response mode; may use private relay emails |
| **Discord** | `identify`, `email`          | Standard OAuth 2.0 flow                                    |

Each provider is enabled by setting its environment variables (client ID and secret). The frontend automatically shows buttons for enabled providers.

### Session Flow

1. Client sends session token in cookie or Authorization header
2. Server hashes token, checks Redis cache
3. Cache miss: query Postgres, fill cache (TTL: 5 minutes)
4. Validate: not revoked, not expired
5. Update `last_active_at` asynchronously (on both the session row and, throttled,
   the denormalized `users.last_active_at` column)

`users.last_active_at` is a denormalized copy of the most recent session activity.
It exists so the admin "last active" view survives retention cleanup, which deletes
expired sessions (see `runRetentionCleanup`); deriving activity from
`MAX(sessions.last_active_at)` would blank out any user idle longer than the 30-day
session lifetime. `updateLastActiveAt` refreshes it fire-and-forget, skipping the
write when it was updated within the last minute to avoid write/index churn.

### Token Format

Session tokens are 32 random bytes, base64url encoded. We store SHA-256 hash in database (never the raw token).

### Token Scopes & Authorization

Authorization is **fail-closed** for tokens. There are four credential types:

- **Browser sessions**: full access. A normal login session has `scopes = NULL`.
- **Scoped sessions**: a session with a non-NULL `scopes` array — a restricted bearer credential minted by a session-based compat API (the Google Reader `ClientLogin` mints one with `reader:full-access`). `validateSession` is **fail-closed**: a scoped session is rejected for full-access use (main tRPC/REST, RSC caller, SSE, `/oauth/authorize`) exactly as if invalid, unless the caller passes `allowScoped: true` (only the Google Reader API does, and it then verifies the reader scope). This keeps a leaked Google Reader token from being replayed as a browser session for account management.
- **API tokens** (`api_tokens`, used by extensions/integrations and the legacy MCP path): restricted to their granted scopes.
- **OAuth 2.1 access tokens**: audience-bound to the MCP endpoint at `/api/mcp` (see below). The Wallabag compat API also validates OAuth access tokens directly, requiring `reader:full-access`.

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

OAuth access tokens are validated only at `POST /api/mcp` (not in the main tRPC/REST context), where the `mcp` scope and the RFC 8707 `resource`/audience binding are both enforced — a token minted for a different resource is rejected. `/api/mcp` also requires signup confirmation (ToS/Privacy/EU agreement) for both OAuth and API tokens, mirroring `confirmedProtectedProcedure` on the tRPC surface.

The **canonical resource identifier** is the MCP endpoint URL — `${issuer}/api/mcp` (`getResourceIdentifier()`), not the bare origin — as required by the MCP authorization spec (2025-06-18) and RFC 9728, and it is what the protected-resource metadata advertises as `resource`. The `authorization_servers` entry remains the origin.

Because the resource identifier has a path, RFC 9728 §3.1 puts its metadata document at the **path-inserted** location: `/.well-known/oauth-protected-resource` inserted _before_ the resource path, i.e. `/.well-known/oauth-protected-resource/api/mcp` (`getProtectedResourceMetadataUrl()`). This is the URL the `401` `WWW-Authenticate` `resource_metadata` points at — matching every known-working remote MCP server (Linear, Sentry, Notion). Pointing it at the **root** `/.well-known/oauth-protected-resource` instead is subtly wrong: the root location is authoritative only for the bare-origin resource, so a document served there that declares a `/api/mcp` resource is an inconsistency that strict clients (claude.ai) reject — discovery completes but the client aborts before registering. The document is served at **both** the path-inserted location and root (the latter for clients/tools that probe it directly). The `WWW-Authenticate` header omits a `scope` parameter and uses the `realm="OAuth" … error="invalid_token"` shape those servers use, and an unauthenticated `/api/mcp` request gets the same RFC 6750-style JSON error body those servers return. The RFC 8414 **authorization-server metadata** is likewise served at both the root (authoritative — our issuer is the bare origin) and the path-inserted `/.well-known/oauth-authorization-server/api/mcp` location: some clients (claude.ai included, upstream #367/#490) construct the second-stage discovery URL from the _resource's_ path, and Linear/Sentry serve that location too. All OAuth/well-known documents are served with `Cache-Control: no-store` — MCP clients re-run discovery on every connect and must never act on a stale cached document.

The whole OAuth/MCP surface also answers URLs with a **trailing slash in place** (`POST /api/mcp/`, `/oauth/token/`, …), because server-to-server OAuth clients (claude.ai's connector uses python-httpx) don't follow redirects on POST and claude.ai has been observed appending trailing slashes (upstream #324). The custom HTTP server (`scripts/server.ts`) strips trailing slashes from exactly these paths (`stripOauthSurfaceTrailingSlash` in `src/server/http/trailing-slash.ts`) before Next.js routing, so Next's built-in 308 trailing-slash redirect stays in force for every other URL — deliberately **not** `skipTrailingSlashRedirect` + middleware, which would make the whole site's slash handling depend on middleware matcher coverage (an unmatched slashed path under that flag is served a broken empty 200). `/register` is excluded: claude.ai POSTs its root-path DCR without a slash, and `GET /register/` keeps redirecting to the signup page.

The audience binding is enforced on both sides, and both sides accept the **set** of identifiers in `getAcceptedResourceIdentifiers()` — the canonical `/api/mcp` URL plus the bare origin (the pre-2026-07 canonical value, kept so tokens minted before the change stay valid until they expire):

- **Mint time** (`/oauth/authorize`): the requested `resource` is validated against the accepted identifiers; a mismatch is rejected with `invalid_target`. The minted token is always bound to the **canonical** `/api/mcp` identifier (`getResourceIdentifier()`) regardless of which accepted alias (or none) the client requested, so newly issued tokens never carry the legacy origin audience. Comparison (`isResourceForThisServer`) ignores trailing slashes and is case-insensitive for scheme/host.
- **Refresh** (`rotateRefreshToken`): the rotated token preserves the grant's own audience, migrating **only** the legacy bare-origin audience to the canonical identifier so a pre-change MCP grant chain moves off the legacy origin on its next refresh instead of self-perpetuating. It deliberately does not blanket-stamp the canonical MCP identifier onto every rotated token — the Wallabag compat API shares this rotation path and mints tokens with a null audience, so forcing the MCP identifier would mislabel a Wallabag credential as MCP-audienced (harmless today since Wallabag gates on scope, not audience, but a latent footgun if Wallabag ever enforces audience).
- **Use time** (`/api/mcp`): the token's stored `resource` must match one of the accepted identifiers. Only legacy tokens issued before audience binding may have a null `resource`, which is still accepted. Because mint binds to the canonical identifier and refresh migrates the legacy origin to it, the legacy origin alias ages out (unused grants expire; used ones migrate), so it can eventually be dropped from `getAcceptedResourceIdentifiers()`.

Dynamic Client Registration (`/oauth/register`) is open per RFC 7591 but rate-limited; it stores only the supported subset of requested scopes and rejects registration if none are recognized (it never falls back to "all scopes"). All three token-endpoint auth methods are supported end-to-end — `client_secret_basic`, `client_secret_post`, and `none` — and the single list (`SUPPORTED_TOKEN_ENDPOINT_AUTH_METHODS` in `oauth/utils.ts`) is shared between the RFC 8414 metadata and `/oauth/register` validation so they can't contradict each other (a metadata/endpoint mismatch makes strict clients abort registration, upstream #285). An omitted `token_endpoint_auth_method` defaults to `client_secret_basic` per RFC 7591 §2 (matching Linear/Sentry/Notion). The token and revocation endpoints accept client credentials from either the form body or an HTTP Basic header (`extractClientCredentials` in `oauth/client-auth.ts`). Token revocation (RFC 7009) is served at `/oauth/revoke` and advertised as `revocation_endpoint`; revoking a refresh token also revokes its linked access token, unknown tokens return 200 per the RFC.

The OAuth **server write** endpoints (`/oauth/register`, `/oauth/token`, `/oauth/authorize`, `/oauth/revoke`) use a dedicated, generous `oauth` rate-limit bucket (per-IP) rather than the strict per-IP `expensive` bucket used by login/subscribe. This is because MCP clients such as claude.ai proxy these requests **server-to-server from a shared egress range** and re-run discovery/registration on every connect; a strict shared-IP bucket would return `429` to legitimate connects, which claude.ai surfaces as "Couldn't register with the sign-in service." These endpoints (and the `.well-known/*` metadata routes and `/api/mcp`) also send CORS headers (and answer `OPTIONS` preflights, exposing `WWW-Authenticate`) so in-browser MCP clients (MCP Inspector, playgrounds) can reach them; claude.ai's own flow is server-side and does not depend on CORS.

The `.well-known/*` OAuth metadata routes and the `/api/mcp` tool surface are **not** rate limited, by the same rule as the rest of the app: only expensive/abusable operations are limited (see below), and neither is one — `.well-known/*` returns cached static JSON, and `/api/mcp` is a normal authenticated read/write surface backed by the same services as the (un-rate-limited) `mcp`-scoped tRPC endpoints. Rate limiting only these two would be a special case with no analogue elsewhere.

#### Dedicated MCP host (`MCP_HOST`)

The claude.ai **web** connector fails against `/api/mcp` on the apex (issue #986) while Claude Code, Claude Desktop, and `mcp-remote` connect fine. Every remote MCP server that _does_ work with the web connector (Notion, Linear, Sentry) is on a dedicated `mcp.*` subdomain with the endpoint at `/mcp` and the OAuth endpoints at the origin root — a clean origin where the paths claude.ai synthesizes at the root (`/authorize`, `/token`, `/register`) collide with nothing (on the apex, `/register` is the signup page, which is why `src/proxy.ts` method-splits it).

Setting `MCP_HOST` (e.g. `mcp.lionreader.com`) makes the **same `app` process** — no extra machine — serve a second, self-consistent OAuth/MCP surface for that host, alongside the unchanged apex surface. The surface is resolved per request from the `Host` header in `src/server/oauth/config.ts` (`resolveSurface`), so route handlers pass `request.headers.get("host")` into `getIssuer`/`getResourceIdentifier`/`getProtectedResourceMetadataUrl`/`getAuthorizationServerMetadata`/`getProtectedResourceMetadata`; omitting the host resolves to the apex, so pre-existing no-arg calls are unchanged.

|                             | Apex (default)                                  | MCP host (`MCP_HOST`)                                              |
| --------------------------- | ----------------------------------------------- | ------------------------------------------------------------------ |
| MCP endpoint                | `/api/mcp`                                      | `/mcp` (`src/app/mcp/route.ts` re-exports the `/api/mcp` handlers) |
| Resource identifier         | `https://{apex}/api/mcp`                        | `https://{mcpHost}/mcp`                                            |
| Protected-resource metadata | `/.well-known/oauth-protected-resource/api/mcp` | `/.well-known/oauth-protected-resource/mcp`                        |
| OAuth endpoints advertised  | under `/oauth/*` (+ root aliases)               | at the origin root (`/authorize`, `/token`, `/register`)           |
| `authorization_servers`     | `[https://{apex}]`                              | `[https://{mcpHost}]`                                              |

`getAcceptedResourceIdentifiers()` is **host-independent**: it returns the audiences for _both_ surfaces (apex `/api/mcp` + legacy origin, and — when `MCP_HOST` is set — the MCP host's `/mcp` + origin), so a token minted on one surface validates at that surface's endpoint regardless of which host the request arrived on. Tokens are minted bound to the requesting host's resource (`/authorize` passes the host into `getResourceIdentifier`), and login/consent redirects stay on that host so a host-only session cookie set during login is sent back to `/authorize`. Refresh rotation is unchanged and preserves each token's own audience. Rollout is infra-only: add DNS + `fly certs add {MCP_HOST}`, then set `MCP_HOST`; until then the code is inert.

Setting `LOG_MCP_REQUESTS=true` makes `src/proxy.ts` emit one structured line per request (host, method, path, **redacted** query, user-agent, and `hasAuthorization` — a boolean, never the token). To catch requests to paths we don't expect (the "wrong URL" / origin-root-fallback failure modes) the proxy matcher runs on all requests, but logging is filtered so ordinary app traffic stays out of the logs: it logs **every** request whose Host is the dedicated `MCP_HOST` (full visibility on the debug host), plus the OAuth/MCP surface paths (`/mcp`, `/api/mcp`, `/authorize`, `/token`, `/register`, `/oauth/*`, `/.well-known/*`) on any host. This is the diagnostic that separates claude.ai's failure modes — e.g. an authenticated `initialize` arriving with no Bearer header (the connector header-drop bug) vs. a registration/discovery failure vs. a probe to an unanticipated path.

---

## Feed Processing

### Polling Strategy

1. Check `next_fetch_at` - is it time?
2. Check `consecutive_failures` - apply exponential backoff if needed (max 7 days)
3. Make HTTP request with `If-None-Match` / `If-Modified-Since` headers
4. Handle response:
   - 304 Not Modified: update `next_fetch_at`, done
   - 200 OK: parse feed, process entries
   - 301 Permanent Redirect: track, update URL after 7-day wait period (HTTP-to-HTTPS applied immediately)
   - 302/307 Temporary Redirect: follow without updating URL
   - 429 Too Many Requests / 5xx: treated as a failure with exponential backoff; when a `Retry-After` header is present it is honored as a floor on the backoff (`max(retryAfterSeconds, backoff)`, capped at the 7-day max), so we never poll earlier than the server asked. 429 backoff is additionally capped at 6 hours (`RATE_LIMIT_MAX_BACKOFF_SECONDS`) — rate limiting means "slow down right now", not "this feed is broken", and the per-IP blocks behind it last hours, not days, so a chronically rate-limited feed must not be starved at the 7-day max (a larger `Retry-After` still wins over the cap)
   - 4xx/5xx: increment failures, backoff. This includes a 404/410 with no tracked redirect: a single 404 is **not** proof the feed is gone (YouTube returns 404 for all of its feeds for a few hours most days — issue #1114), so instead of jumping straight to a 7-day next fetch, the ordinary backoff ladder applies — it converges to the same 7-day cadence if the 404 persists, and one success resets it. A 404/410 with a tracked redirect URL still applies the redirect immediately
5. Calculate `next_fetch_at` based on Cache-Control (10min with cache hint, 60min default min, 7day max). A URL plugin can raise the minimum for its source (`FeedCapability.minFetchIntervalSeconds`): YouTube serves `max-age=900` but rate-limits RSS fetches per IP, so its plugin floors polling at 1 hour

### Feed Types

- **RSS/Atom/JSON**: Standard web feeds fetched via HTTP
- **Email**: Newsletters received via ingest email addresses
- **Saved**: User-saved articles (read-it-later)

### Respectful Fetching

Lion Reader respects server Cache-Control headers and applies exponential backoff for failed fetches.

### WebSub Push & Backup Polling

When a feed advertises a hub, we subscribe via WebSub (see [Real-time Updates](#real-time-updates)) and drop the feed to a 24h **backup poll** cadence (`reason: "websub_backup"`), trusting the hub to push new content in real time. A hub can silently stop delivering while we still believe it's active, so two mechanisms bound how long a dead hub can keep a feed stale:

A content push (`ingestWebsubNotification`) processes the pushed entries but **does not** advance `feeds.last_fetched_at` or `feeds.last_entries_updated_at`: a push isn't a full fetch (it can be a delta), so `last_fetched_at` must keep meaning "last time we fetched the whole feed" and `last_entries_updated_at` must keep marking the last poll's generation. Leaving both alone is what makes pushed entries (`last_seen_at > last_entries_updated_at`) visible to new subscribers via the `>=` populate, lets `shouldRefetchOnSubscribe` treat a WebSub feed as stale once its last real poll ages past the cache window, and keeps feed-health monitoring counting only real fetches (see **Entry Visibility** above). It **does** clear `feeds.body_hash`, so the next poll can't short-circuit on an unchanged-body match and skip re-processing — important when the publisher removes a pushed entry and the feed body returns byte-identical to the last poll; the re-processing poll then re-stamps the current set and its disappeared-entry detection (which matches `last_seen_at >= previousLastEntriesUpdatedAt`, so it catches push-stamped entries above the pointer) drops the removed one from the generation. `entries.last_seen_at` is written **monotonically** (advance-only), so a subscribe-time inline refresh racing a worker poll of the same feed can't regress a stamp below the (forward-only) `last_entries_updated_at`.

- **Lease clamp** (`MAX_LEASE_SECONDS`, 14 days, `src/server/feed/websub.ts`): we honor at most a 14-day lease regardless of what the hub grants, so we re-verify the subscription — and re-confirm the hub is still delivering — at least that often. We don't request a shorter lease; we just renew earlier. This bounds the quiet-feed case, where a silently-dropped subscription produces no new content to reveal the breakage.

- **Backup-poll push-reliability tally** (`websub_hub_stats`, `src/server/feed/websub-hub-stats.ts`): this handler (`processSuccessfulFetch`) only runs for scheduled/backup polls — hub pushes go through `ingestWebsubNotification` instead — so any **new** entry a backup poll finds on a feed we believed push was covering is a push miss. We tally, per hub URL, how new articles first reached us: `articles_announced_by_hub` (pushed), `articles_announced_by_backup` (a confirmed miss), and `articles_near_miss` (found by backup but published within a 15-min grace window, or with an unknown date — too recent to confidently blame the hub, e.g. a publish-time race). This is purely observational today: nothing reads it to change fetch behavior; it exists so a chronically-broken hub (e.g. Google's `pubsubhubbub.appspot.com`, which accepts pings but never pushes) becomes visible in aggregate and can be dealt with later.

#### Non-disruptive renewal

Renewing an already-active subscription must not disrupt it while the hub re-verifies. `subscribeToHub` keeps the row `active` and just re-requests the lease; it does **not** flip the row to `pending`, and the `callback_secret` **never rotates** for a given row — it re-sends the existing secret as `hub.secret`. Because the hub and we always hold the same secret, a verification GET (which carries no request identifier we could correlate to a specific subscribe) can never leave them out of sync, and content pushes are never dropped during a renewal. Only `applyVerificationChallenge` advancing `expires_at` on the next verification takes the row back out of the sweep's stale window.

Because the row stays `active` with its `expires_at` unadvanced, the hourly renewal sweep keeps finding it and retries the hub POST — a transient failure (deploy restart dropping the callback, brief network fault) no longer tears the subscription down. Staleness is measured directly from `expires_at`: once a subscription is more than `RENEWAL_STALL_GRACE_MS` (6 h) past expiry — the hub accepted our (re)subscribe but never verified — the sweep reverts it to polling via a **compare-and-swap** (`revertStalledSubscription`, conditional on the row being still `active` and still stale) so a verification that raced the sweep isn't clobbered. Measuring from `expires_at` rather than a separate "renewal started" timestamp means a verification that lands late, or an old release renewing without our bookkeeping, self-corrects with no extra state: it advances `expires_at`, removing the row from the stale window. Reverting to polling lets the next fetch resubscribe cleanly (a fresh subscription that flips `websub_active` only on verification); a late verification for the abandoned cycle is declined because `applyVerificationChallenge` refuses to activate an `unsubscribed` row. This closes the wedge where a hub that accepts the resubscribe but never verifies left the feed permanently `pending` and silently push-dead (issue #1079).

### SSRF Protection

All server-side fetches that target user-influenced URLs (feed preview/discover, feed fetching, full-content fetching, WebSub hub callbacks) are guarded against Server-Side Request Forgery to private/internal networks. The shared helper `fetchWithSsrfProtection(url, init)` in `src/server/http/ssrf.ts` performs the fetch and:

1. Rejects literal private/reserved IP hosts up front (e.g. `http://169.254.169.254/`, `http://127.0.0.1/`, IPv4-mapped IPv6 literals, decimal-encoded IPs which WHATWG `URL` normalizes to dotted form). undici skips the custom DNS lookup for IP literals, so they must be checked here.
2. Attaches a custom undici dispatcher whose DNS `lookup` resolves the hostname, blocks if **any** resolved address is private, and connects only to the vetted address — closing the DNS-rebinding TOCTOU gap.

**Redirects are validated per hop.** Because undici skips the custom `lookup` for IP-literal hosts, letting `fetch` follow redirects internally would connect to a redirect target like `http://169.254.169.254/` with **no** validation. So `fetchWithSsrfProtection` always drives the underlying fetch with `redirect: "manual"` and follows redirects itself in a loop, re-running the literal-IP check (step 1) on every hop's URL before connecting; the dispatcher (step 2) covers hostname hops. Callers that pass `redirect: "manual"` (the feed fetcher, which tracks permanent redirects itself) get the first response back unfollowed and re-enter the helper per hop; `redirect: "error"` throws on the first redirect. The loop follows up to 20 hops and applies the Fetch spec's method downgrade (301/302 on a POST, and 303, become GET with the body dropped). No caller can opt out of per-hop validation.

The helper must perform the fetch itself rather than hand the dispatcher to global `fetch`: the dispatcher is built from the npm `undici` package, while Node's global fetch is a different bundled undici copy that accepts a foreign dispatcher but skips response body decompression with it (observed on Node 26), corrupting every compressed response. `fetchWithSsrfProtection` uses the npm package's own `fetch` so the dispatcher and fetch always come from the same copy.

Blocked ranges cover loopback, RFC 1918 private, carrier-grade NAT, link-local (incl. cloud metadata), documentation/test, multicast, and reserved space for both IPv4 and IPv6 (and IPv4-mapped IPv6). Set `ALLOW_PRIVATE_NETWORK_FETCH=true` to disable the block for dev/test environments that fetch from localhost (this is the default in `.env.test`).

---

## Real-time Updates

### Architecture

1. Feed worker fetches feed, finds new entry
2. Worker publishes to per-feed Redis channel: `PUBLISH feed:{feedId}:events {type, entryId, ...}`
3. SSE connections subscribe only to channels for feeds their user cares about
4. App server receives message, forwards to client
5. Client receives event, patches the React Query cache (see `src/FRONTEND_STATE.md`)
6. UI updates automatically

### Channel Design

Per-feed channels for scalability - servers only receive events they care about:

| Channel Pattern        | Events                                                                                                                                                                                                                   |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `feed:{feedId}:events` | `new_entry`, `entry_updated`                                                                                                                                                                                             |
| `user:{userId}:events` | `subscription_created`, `subscription_updated`, `subscription_deleted`, `entry_state_changed`, `mark_all_read`, `tag_created`, `tag_updated`, `tag_deleted`, `import_progress`, `import_completed`, `saved_feed_created` |

When a user subscribes to a new feed, the SSE connection dynamically subscribes to that feed's channel. `saved_feed_created` is a server-internal signal (not forwarded to the client): it fires when a user's saved-articles feed is first created so already-open connections subscribe to its channel and the first saved article broadcasts live rather than only after the next reconnect.

### Connection Efficiency

- **Single client connection**: the browser opens the `/api/v1/events` EventSource directly (one connection per tab). SSE availability (e.g. Redis down) is detected via a lightweight `HEAD /api/v1/events` check only on the error path; a 503 switches the client to polling the sync endpoint.
- **Shared Redis subscriber**: each app process holds a single Redis subscriber connection (`createPubSubSubscription` in `src/server/redis/pubsub.ts`). Channel subscriptions are reference-counted across SSE connections and messages are fanned out in-process, so Redis connections don't grow with the number of connected users.

---

## API Design

### Subscription-Centric Model

The API uses **subscription ID as the primary user-facing identifier**. While feeds are shared internally for efficiency (fetching `nytimes.com/rss` once serves all subscribers), this is hidden from clients. Users interact with "their subscriptions" rather than "shared feeds."

- Subscription responses include feed metadata (title, URL, etc.) flattened into a single object
- Entry filtering uses `subscriptionId`, not `feedId`
- The `feeds` router is only used for pre-subscription operations (preview, discover)

### tRPC Router Structure

Routers are organized by resource:

- `auth` - Registration, login, logout, OAuth
- `users` - Profile, sessions, settings
- `subscriptions` - CRUD for feed subscriptions (primary user-facing API)
- `entries` - List, read, star, mark read
- `feeds` - Preview, discover feeds (pre-subscription only)
- `tags` - Tag CRUD, subscription-tag assignments
- `narration` - Text-to-speech generation
- `summarization` - AI article summarization
- `imports` - OPML import/export, Feedbin migration
- `saved` - Save/delete/upload articles (read-it-later)
- `apiTokens` - Scoped API token management
- `feedStats` - Per-feed statistics and health monitoring
- `brokenFeeds` - List feeds with consecutive fetch failures
- `blockedSenders` - Block email senders, attempt unsubscribe
- `ingestAddresses` - Manage per-user newsletter ingest email addresses
- `sync` - Cursor-based delta sync for offline clients
- `admin` - Invite management (invite-only mode)

### HTTP API Surfaces

Besides the browser tRPC endpoint (`/api/trpc`), the same routers/services back several HTTP surfaces under `src/app/api/`:

- **REST API** (`/api/v1/*`): generated from tRPC procedures' `openapi` meta via `trpc-to-openapi`; the OpenAPI 3.0 spec is served at `/api/openapi`. Includes the SSE stream at `/api/v1/events`.
- **Google Reader API** (`/api/greader.php/*`): compatibility layer for Google Reader clients. Saved (read-it-later) articles have no subscription row, so they are exposed to Google Reader clients as a synthetic uncategorized "Saved Articles" subscription keyed by the saved feed's own id (`feed/{int64(savedFeedId)}`) — see issue #730. `resolveFeedStream` maps that stream id back to `type='saved'`, `formatEntryAsItem` gives saved items that feed as their `origin.streamId`, and `subscription/list` + `unread-count` include the synthetic feed. A subscription (not a folder) avoids the folder-name-uniqueness edge cases a synthetic folder would create.
- **Wallabag API** (`/api/wallabag/*`): compatibility layer for Wallabag read-it-later clients.
- **MCP** (`/api/mcp`): see [MCP Server](#mcp-server).
- **Webhooks** (`/api/webhooks/*`): Mailgun inbound email, WebSub hub callbacks.

This list is not exhaustive. Other route handlers under `src/app/api/` include
`/api/health` (Fly.io/load-balancer health check), `/api/share` (PWA Web Share
Target), `/api/admin/session` (admin session helper), and `/api/v1/telemetry`
(client telemetry ingest).

### Pagination

Cursor-based pagination everywhere:

- Request: `{ cursor?: string, limit?: number }`
- Response: `{ items: T[], nextCursor?: string }`
- Cursor is a base64url-encoded JSON keyset tuple — the sort key of the last row,
  so the next page resumes with a `> cursor` comparison. The tuple's shape depends
  on the ordering: `{ ts, id }` for entry lists (`published_or_fetched_at` + id
  tiebreaker), `{ title, id }` for subscriptions (alphabetical), and a float rank
  (encoded in the same `ts` field) for full-text search results. base64url (not standard
  base64) so the cursor is safe to echo back in a URL query string — it surfaces as
  the Google Reader `continuation` token, and some clients concatenate query params
  without URL-encoding, where a `+` from standard base64 would arrive as a space and
  corrupt the cursor.

### Rate Limiting

Token bucket via Redis, per-user. Different buckets for different operations (e.g., search is more limited than reads).

**Password brute-force protection**: every password-accepting path is rate-limited two ways. A per-IP `expensive` bucket (10 burst, 1/sec) caps a single source, and a **shared per-account** `expensive` bucket keyed by normalized (trimmed/lower-cased) email caps total guesses against one account regardless of source IP — so a distributed, IP-rotating brute-force is throttled too. The account key is shared across the tRPC `auth.login` mutation, Google Reader `ClientLogin`, and the Wallabag password grant via `checkAccountRateLimit`/`checkAccountRouteRateLimit` in `src/server/rate-limit/`. The tRPC login consumes the account bucket _before_ the user lookup so attempts against non-existent accounts are throttled identically (no enumeration side channel). The OAuth 2.1 `/oauth/token` endpoint takes no password (only `authorization_code`/`refresh_token` grants), so it has no account key and uses the generous `oauth` bucket.

Ordinary rate limits **fail open** when Redis is unavailable (availability over strictness for reads/writes). The **account** bucket is the exception: `checkAccountRateLimit` passes `fallback: "memory"`, so during a Redis outage it degrades to a per-process in-memory token bucket instead of failing fully open — password brute-force protection would otherwise evaporate exactly when the system is degraded. The in-memory map is size-bounded (LRU eviction) so an attacker rotating identifiers can't grow it without limit. Per-process (not cross-server) but it bounds guesses on each server without hard-locking legitimate users out.

### Error Responses

Errors use tRPC's standard error envelope, extended by the `errorFormatter` in
`src/server/trpc/trpc.ts`:

```typescript
{
  message: string;      // Human-readable
  code: number;         // JSON-RPC error code
  data: {
    code: string;        // tRPC error code ('UNAUTHORIZED', 'NOT_FOUND', 'BAD_REQUEST', ...)
    httpStatus: number;
    path?: string;
    // Custom app error code set via createError in errors.ts
    // (e.g. 'SIGNUP_CONFIRMATION_REQUIRED', 'INVITE_REQUIRED', 'CONTENT_TOO_LARGE')
    appErrorCode?: string;
    // Flattened Zod issues when input validation failed
    zodError: object | null;
  }
}
```

### Services Layer

Business logic is extracted into reusable service functions in `src/server/services/`:

| Service                 | Functions                                                                                                                                                                                                                           |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `entries.ts`            | `listEntries`, `getEntry`, `getEntries`, `selectFullEntry`/`toFullEntry` (sanitized read path), `markEntriesRead`, `markAllEntriesRead`, `updateEntryStarred`, `countEntries`, `countTotalEntries`                                  |
| `subscriptions.ts`      | `listSubscriptions`, `getSubscription`, `createSubscription`                                                                                                                                                                        |
| `saved.ts`              | `saveArticle`, `deleteSavedArticle`, `uploadArticle`, `createUploadedArticle`                                                                                                                                                       |
| `tags.ts`               | `listTags`, `createTag`, `updateTag`, `deleteTag`                                                                                                                                                                                   |
| `counts.ts`             | `getGlobalUnreadCounts`, `getEntryRelatedCounts`, `getBulkEntryRelatedCounts`, `getNewEntryRelatedCounts`, `getSubscriptionDeletionCounts` (all from the denormalized counters, not scans)                                          |
| `reconcile-counters.ts` | `reconcileCounters` - daily self-healing sweep of the denormalized unread counters against ground truth                                                                                                                             |
| `entry-filters.ts`      | `buildEntryFeedFilter`, `buildEntryFilterConditions`, `buildTaggedFeedIdsSubquery` - shared filter construction                                                                                                                     |
| `narration.ts`          | Text-to-speech operations                                                                                                                                                                                                           |
| `full-content.ts`       | `fetchFullContent`, `fetchAndStoreFullContent` - fetch, sanitize, and persist full article content                                                                                                                                  |
| `entry-events.ts`       | `publishMarkReadStateChanges`, `publishStarredStateChange` - shared `entry_state_changed` publishing, invoked from `markEntriesRead`/`updateEntryStarred` so every caller (tRPC, MCP, Google Reader, Wallabag) emits the same event |
| `summarization.ts`      | AI-powered article summarization                                                                                                                                                                                                    |
| `users.ts`              | `deleteUser` - account deletion                                                                                                                                                                                                     |
| `retention.ts`          | `runRetentionCleanup` - data retention background job                                                                                                                                                                               |
| `resanitize.ts`         | `selectStaleEntriesForResanitize`, `persistResanitizedFamily` - shared primitives for re-sanitizing stored entry HTML after a `SANITIZER_VERSION` bump (read-path self-heal + manual `scripts/resanitize-bulk.ts`)                  |

Entry content served by `getEntry`/`getEntries`/`toFullEntry` is **sanitized in
the services layer** (see "Sanitizing untrusted HTML" in CLAUDE.md), so every
consumer — tRPC, MCP, Google Reader, Wallabag — gets the same guarantee.

**Pattern**: Pure functions accepting `db` and parameters, returning data objects. Shared across tRPC routers, MCP server, and background jobs.

```typescript
// src/server/services/entries.ts
export async function listEntries(db, params) {
  /* ... */
}

// Usage in tRPC router
import * as entriesService from "@/server/services/entries";
export const entriesRouter = createTRPCRouter({
  list: protectedProcedure.query(({ ctx, input }) => {
    return entriesService.listEntries(ctx.db, { ...input, userId: ctx.session.user.id });
  }),
});

// Usage in MCP server
const entries = await entriesService.listEntries(db, { userId, ...filters });
```

---

## Frontend Architecture

### Client-Side Routing

Next.js App Router handles **initial page loads only**. After hydration, all in-app
navigation is shallow routing: `ClientLink` calls `window.history.pushState` (via
`src/lib/navigation.ts`), and `AppRouter` (`src/components/app/AppRouter.tsx`) re-derives
what to render from `usePathname()`. The `page.tsx` files exist to prefetch route-specific
data on initial load; their rendered output is hidden by the app layout. Navigation costs
zero server requests — data is served from the React Query cache, kept fresh by SSE.

Consequences:

- Never use Next's `<Link>` or `router.push()` for internal navigation — they trigger
  per-navigation RSC fetches. Use `ClientLink`.
- `useParams()` doesn't update on `pushState`; dynamic params are parsed from the pathname
  by regex.

Native App Router navigation was evaluated and rejected in issue #872 (per-navigation
RSC fetches defeat the SSE-fed cache).

### Route Structure

```
app/
  (auth)/                     # Login, register, forgot password
  (app)/                      # Main app (requires auth)
    all/                      # All entries timeline
    starred/                  # Starred entries
    saved/                    # Saved articles
    recently-read/            # Recently-read timeline (sortBy: readChanged)
    uncategorized/            # Entries from untagged subscriptions
    subscription/[id]/        # Single subscription entries (uses subscription ID)
    tag/[tagId]/              # Entries filtered by tag
    settings/                 # User settings (rendered by UnifiedSettingsContent)
      appearance/             # Theme, font, text size
      subscriptions/          # Subscription management + feed stats
      email/                  # Newsletter ingest addresses + blocked senders
      ai/                     # AI & narration settings
      integrations/           # Integration settings + API tokens
      feed-health/            # Broken/failing feed health
      sessions/               # Active session management
      delete-account/         # Account deletion
    subscribe/                # Add subscription flow
  save/                       # Bookmarklet landing page (top-level, no auth layout)
  extension/save/             # Browser extension save page
  demo/                       # Interactive demo (no auth required)
```

### Component Architecture

- `components/layout/` - Sidebar, header
- `components/entries/` - Entry list, content, actions
- `components/feeds/` - Feed list, add feed dialog
- `components/narration/` - Audio playback controls
- `components/saved/` - Saved article views
- `components/settings/` - Settings page components
- `components/subscribe/` - Subscription flow components
- `components/summarization/` - AI summary display
- `components/keyboard/` - Keyboard shortcut handling
- `components/auth/` - Authentication forms
- `components/app/` - App-level components
- `components/ui/` - Generic UI primitives

---

## MCP Server

Lion Reader exposes functionality to AI assistants via the [Model Context Protocol (MCP)](https://modelcontextprotocol.io/). Two transports are supported:

- **Streamable HTTP** at `POST /api/mcp` — for remote clients such as claude.ai. Authenticated with OAuth 2.1 access tokens (with the `mcp` scope) or legacy API tokens. Runs statelessly inside the Next.js route handler via `WebStandardStreamableHTTPServerTransport`, creating a fresh server+transport pair per request.
- **stdio** (`pnpm mcp:serve`) — for local clients such as Claude Desktop.

Both transports register the same tools and call the same services layer.

### Architecture

```
┌─────────────────┐  HTTP (OAuth/API token)   ┌─────────────────┐
│  Remote client  │ ───────POST /api/mcp────→ │                 │
│  (claude.ai)    │                           │  MCP Server     │
└─────────────────┘                           │  lion-reader    │
┌─────────────────┐         stdio             │  (shared tools) │
│  Local client   │ ←───────────────────────→ │                 │
│ (Claude Desktop)│                           └────────┬────────┘
└─────────────────┘                                    │
                                                       │ uses
                                                       ▼
                                              ┌─────────────────┐
                                              │ Services Layer  │
                                              │ (same as tRPC)  │
                                              └────────┬────────┘
                                                       │
                                                       ▼
                                              ┌─────────────────┐
                                              │   PostgreSQL    │
                                              └─────────────────┘
```

### Available Tools

| Tool                   | Description                                            |
| ---------------------- | ------------------------------------------------------ |
| `list_entries`         | List feed entries with filters, search, and pagination |
| `get_entry`            | Get single entry with full content                     |
| `mark_entries_read`    | Mark entries as read/unread (bulk)                     |
| `star_entries`         | Star/unstar entries                                    |
| `count_entries`        | Get entry counts with filters                          |
| `save_article`         | Save a URL for later reading                           |
| `delete_saved_article` | Delete a saved article                                 |
| `upload_article`       | Upload Markdown content as an article                  |
| `list_subscriptions`   | List and search active subscriptions                   |
| `get_subscription`     | Get subscription details                               |
| `list_tags`            | List tags with feed/unread counts                      |
| `create_tag`           | Create a new tag                                       |
| `update_tag`           | Update a tag's name or color                           |
| `delete_tag`           | Delete a tag (soft delete)                             |

### Running the MCP Server

For local stdio clients (e.g. Claude Desktop):

```bash
pnpm mcp:serve
```

Remote clients connect to the deployed app's `POST /api/mcp` endpoint over Streamable HTTP, authenticating with an OAuth 2.1 access token (`mcp` scope) or a scoped API token.

---

## Plugin System

Lion Reader has an extensible plugin system (`src/server/plugins/`) that consolidates per-source custom parsing behind a capability-based interface, so adding a content source means writing one self-contained plugin instead of scattering URL checks across core modules. The code is the source of truth: `types.ts` (interfaces), `registry.ts` (hostname-indexed registry), `index.ts` (registration).

### Architecture

The registry indexes plugins by hostname for O(1) lookup, then calls the plugin's `matchUrl(url)`; `findWithCapability(url, capability)` returns the first plugin that matches AND declares the capability:

- **`feed`** capability: transform page URLs to feed URLs, clean entry content, synthesize entry content from parsed-entry metadata (e.g., YouTube's embedded player + description), transform feed titles (e.g., LessWrong GraphQL API), raise the source's minimum polling interval (e.g., YouTube rate-limit avoidance)
- **`savedArticle`** capability: fetch full article content for read-it-later, optionally skipping Readability when the source returns clean HTML

`matchUrl` must be selective, not "any URL on my hosts" — a plugin should only match URLs it can actually handle (e.g. LessWrong `/tag/...` pages must return `false` so the caller falls back to normal fetching).

A plugin can also declare `feedDefaultsToFullContent(feedUrl)`: when it returns true for a feed URL, a **fresh** subscription to that feed starts with `fetch_full_content` on (the frontend then hydrates each entry's full content on open, cached on the shared `entries` row). Used for sources whose feed entries are truncated or drop embedded content — Bluesky's native RSS renders quote posts/images/link cards as a bare placeholder. Matched by hostname + the plugin's predicate on the **feed** URL (not `matchUrl`, which matches entry URLs); a resubscribe keeps the user's stored preference. See `createSubscription` and `feedDefaultsToFullContent` in `src/server/plugins/index.ts`.

### Available Plugins

| Plugin          | Capabilities           | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| --------------- | ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **LessWrong**   | `feed`, `savedArticle` | GraphQL API for posts/comments, user profile feeds                                                                                                                                                                                                                                                                                                                                                                                                         |
| **Google Docs** | `savedArticle`         | Fetch Google Docs content via API                                                                                                                                                                                                                                                                                                                                                                                                                          |
| **ArXiv**       | `savedArticle`         | Fetch ArXiv paper content                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| **GitHub**      | `savedArticle`         | Fetch GitHub content                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| **YouTube**     | `feed`, `savedArticle` | Feed: polling floor (1h) to avoid per-IP rate limiting; synthesizes entry content (embedded player + description) from Media RSS metadata. SavedArticle: saving a watch/`youtu.be`/shorts/live URL synthesizes the same embed-plus-description body from the watch page's metadata (Readability would fail on the JS watch page)                                                                                                                           |
| **Bluesky**     | `savedArticle`         | Native RSS (`bsky.app/profile/{handle}/rss`) already works for subscribing, but drops post embeds (quote posts, images, link cards, videos) behind a placeholder. SavedArticle hydrates a post via the public AT Protocol appview (`public.api.bsky.app`) — resolving handle→DID, then `getPosts` — and renders the text (with rich-text facets) + embeds as clean HTML. Declares `feedDefaultsToFullContent` so new subscriptions default to full content |

---

## Infrastructure

### Fly.io Deployment

- Single region (lax) with canary deployment strategy
- Three process types:
  - `app` - Next.js web server (min 2 machines for zero-downtime deploys)
  - `worker` - Background job processor (feed fetching)
  - `discord` - Discord bot (lightweight, single Gateway connection)
- Postgres managed database
- Redis for caching and pub/sub
- Release command runs migrations automatically before deploy

### Migration Compatibility (Expand/Contract)

**Every migration must be backward-compatible with the previous release.** Nothing structural enforces this — it is a rule to follow when writing migrations.

Why: `fly.toml` runs migrations in `release_command` _before_ the canary deploy, so the old code always runs against the new schema during rollout (and keeps running against it if the deploy fails health checks or is rolled back — migrations are not rolled back).

Practically, this means using the expand/contract pattern:

- **Expand** (safe in one release): add nullable columns or columns with defaults, add tables, add indexes, create views alongside old ones
- **Contract** (requires two releases): to drop or rename a column/table, first ship a release whose code no longer references it; only then ship the migration that removes it. A rename is an add + dual-write/backfill + drop across releases, never a single `ALTER ... RENAME`.

### Local Development

Docker Compose provides Postgres and Redis for local development. See README for setup instructions.

### Object Storage (S3/Tigris)

An **optional** S3-compatible object store re-hosts external images that would
otherwise expire or leak referrers — currently only Google Docs images, which
carry short-lived `contentUri` links. `src/server/storage/s3.ts` (`isStorageAvailable`,
`fetchAndUploadImage`) signs requests with `aws4fetch` and works against AWS S3 or
Fly.io Tigris; `src/server/google/docs.ts` calls it to fetch each image (SSRF-protected,
size-limited) and rewrite the document to the re-hosted URL.

Configured via `STORAGE_BUCKET`, `STORAGE_ENDPOINT`, `STORAGE_REGION`,
`STORAGE_PUBLIC_URL_BASE` (see `[env]` in `fly.toml`) plus the `STORAGE_ACCESS_KEY_ID`
/ `STORAGE_SECRET_ACCESS_KEY` secrets. The feature **no-ops when unconfigured**:
`isStorageAvailable()` returns false and image re-hosting is skipped, so the rest of
the app runs unaffected.

### CI/CD

- GitHub Actions for CI (typecheck, lint, unit/integration/e2e tests)
- Deploy to Fly.io runs only after the CI workflow succeeds on master (`workflow_run` gate in `deploy.yml`); deploys queue rather than cancel each other so a mid-flight canary rollout is never killed
- In CI, e2e tests run against the production build (`next build` + `node dist/server.js`), not the dev server

---

## Observability

### Stack

- **Errors**: Sentry
- **Metrics**: Prometheus via `prom-client` (each process exposes `/metrics` on its own port)
- **Logging**: Structured JSON logs

### Key Metrics

- Feed fetch success/failure rates
- API request latency and error rates
- Background job queue depth and processing time
- Active SSE connections

### Feed Fetch Health Alerting

The `monitor_feed_health` singleton job (worker, every 15 minutes) enforces the invariant **"at least one feed must fetch successfully every N minutes"** (default 120, `FEED_HEALTH_MAX_SUCCESS_AGE_MINUTES`). Since feeds are polled at least hourly in steady state, zero successes anywhere means fetching is broken globally (worker stuck, fetch/parse regression, egress failure) — this catches whole-pipeline breakage that per-feed failure tracking doesn't surface. See `src/server/feed/health.ts`.

On each run the job **pings a healthchecks.io check** (`FEED_HEALTH_HEARTBEAT_URL`): a success ping when healthy, a `/fail` ping when not, POSTing a plain-text body (status, reason, last successful fetch, failing/pollable counts, most recent feed error) that healthchecks.io includes in its notification emails so the alert explains _why_ without opening the app. The external monitor owns alert delivery and cadence (de-dupes, sends its own recovery email). The job also **updates Prometheus gauges** `feed_last_successful_fetch_age_seconds` and `feeds_failing`.

#### Monitoring layout: three independent checks

Alerting uses [healthchecks.io](https://healthchecks.io) (or any compatible dead-man's-switch) via the shared `pingHealthcheck`/`startHeartbeat` helpers in `src/server/notifications/healthchecks.ts`. Each ping URL is a **separate** check, so the long-running processes get distinct ones — that way concurrent failures are individually visible and a dead worker is distinguishable from a fetch regression:

| Check                    | Env var                     | Pinged by                            | Signals                                                                                                              |
| ------------------------ | --------------------------- | ------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| **Feed fetch health**    | `FEED_HEALTH_HEARTBEAT_URL` | `monitor_feed_health` (every 15 min) | `/fail` when no feed has fetched successfully within the threshold (fetch/parse pipeline quality)                    |
| **Worker liveness**      | `WORKER_HEARTBEAT_URL`      | worker process (every 1 min)         | success while the job loop is active; `/fail` if the loop wedges past the staleness threshold; missing = worker dead |
| **Discord bot liveness** | `DISCORD_BOT_HEARTBEAT_URL` | discord-bot process (every 5 min)    | missing pings = bot dead or crash-looping                                                                            |

All three are optional (a process skips pinging when its URL is unset). A fully dead worker trips both the worker-liveness and feed-health checks (the monitor job stops pinging too); the worker-liveness check is the more specific signal, while a feed-health `/fail` with a green worker check points at the fetch pipeline rather than the process.

---

## Testing Strategy

### Philosophy

Structure code so business logic is pure and can be unit tested without mocks. Integration tests use real databases.

### Test Structure

```
tests/
  unit/           # Fast, no I/O - pure logic tests (frontend cache logic under unit/frontend/)
  integration/    # Requires Docker services - full flow tests
  e2e/            # Playwright browser tests - real app server + Postgres + Redis
```

### Guidelines

- **Unit tests**: Feed parsing, cache header interpretation, scheduling logic, React Query cache operations (against real `QueryClient` instances)
- **Integration tests**: Auth flows, CRUD operations, full fetch cycles
- **E2E tests**: Realtime SSE → cache → UI flows in a real browser
- **No mocks of internal code**: Refactor if mocking is needed
- **Real databases in integration tests**: Docker Compose provides Postgres and Redis

### End-to-End Tests (Playwright)

`pnpm test:e2e` runs Playwright tests (`tests/e2e/`) against a real app server started automatically on port 4983 (override with `E2E_PORT`) using the test database from `.env.test`. Requires the docker-compose Postgres and Redis services, like the integration tests.

Key design points:

- **No UI login flow**: tests seed users/feeds/entries directly in the database (`tests/e2e/helpers.ts`) and authenticate by inserting a session row and setting the `session` cookie.
- **Real event pipeline**: tests publish events through the same `src/server/redis/pubsub.ts` functions the worker uses, exercising Redis → SSE endpoint → EventSource → `handleSyncEvent` → cache → UI. `waitForChannelSubscriber` polls `PUBSUB NUMSUB` to avoid publishing before the SSE handler is listening.
- **Minimal-request assertions**: `recordTrpcProcedures(page)` records every tRPC procedure the page calls. Tests assert that SSE events update the UI with _zero_ `entries.*` refetches — this encodes the delta-update invariant documented in `src/FRONTEND_STATE.md` as a regression test instead of a code-review concern.
- **Isolation**: each test creates its own user and feeds (unique IDs), so tests don't interfere with each other or with leftover data; the suite runs serially against one shared server.
