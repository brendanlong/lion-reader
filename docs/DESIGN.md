# Lion Reader Design Document

High-level architecture and design decisions. Mechanics, edge cases, and invariants live in per-directory `CLAUDE.md` files, pointed to from each section — read the relevant one before working on a subsystem.

## Table of Contents

1. [System Architecture](#system-architecture)
2. [Database Design](#database-design)
3. [Authentication](#authentication)
4. [Feed Processing](#feed-processing)
5. [Real-time Updates](#real-time-updates)
6. [API Design](#api-design)
7. [Frontend Architecture](#frontend-architecture)
8. [MCP Server](#mcp-server)
9. [Plugin System](#plugin-system)
10. [Infrastructure](#infrastructure)
11. [Observability](#observability)
12. [Testing Strategy](#testing-strategy)

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

Detailed data-model invariants (entry visibility, subscription attribution, unread-counter algebra, idempotency/watermark rules, pagination mechanics) live in `src/server/CLAUDE.md`.

### ID Strategy

All primary keys use **UUIDv7**: globally unique without coordination, time-ordered (good B-tree insert locality, natural keyset-pagination tiebreaker). The `id` is **not** the timeline sort key — the timeline sorts by publish time, which diverges from insert order.

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

Each of these is specified in full in `src/server/CLAUDE.md`; the summaries here state the decision and its rationale.

- **Entry Visibility**: an entry is visible to a user iff a `user_entries` row exists and the entry is from an active subscription, starred, or a saved article. Rows are created at subscribe time (current feed contents only) and at fetch time (state-driven, self-healing fanout to active subscribers). This insert-time gating — not the view — is what prevents leaking pre-subscription private content.
- **Subscription attribution**: each `user_entries` row carries a denormalized `subscription_id`, the sole entry→subscription link (replaced a junction table, issue #1117).
- **Unread counts**: denormalized onto trigger-maintained counter columns so badges are O(subscriptions) arithmetic, never entry scans; a daily reconcile job repairs (and loudly reports) drift.
- **Soft deletes**: subscriptions use `unsubscribed_at`, so resubscribing restores read state.
- **Content change detection**: entries store a `content_hash`; changed content overwrites the previous version.
- **Read/star idempotency & delta sync**: per-field last-writer-wins watermarks (`*_changed_at`) resolve conflicting multi-client updates; `updated_at` moves only on meaningful changes so re-asserts don't churn delta sync (issues #1118, #1084, #1160 — "Row Written vs. Value Flipped" in `src/server/CLAUDE.md`).
- **Timeline sort key**: `COALESCE(published_at, fetched_at)` is denormalized onto `user_entries.published_or_fetched_at` so one index serves the user filter + timeline sort.

---

## Authentication

Details (session flow, cookie design, scopes, brute-force protection): `src/server/auth/CLAUDE.md`.

Custom auth using battle-tested primitives: **`arctic`** (OAuth for Google/Apple/Discord), **`argon2`** (password hashing), and custom token-based session management stored in Postgres with a Redis cache. Session tokens are 32 random bytes, base64url encoded; only the SHA-256 hash is stored.

### OAuth Providers

| Provider    | Scopes                       | Notes                                                      |
| ----------- | ---------------------------- | ---------------------------------------------------------- |
| **Google**  | `openid`, `email`, `profile` | Optional `documents.readonly` for Google Docs access       |
| **Apple**   | `name`, `email`              | Uses form_post response mode; may use private relay emails |
| **Discord** | `identify`, `email`          | Standard OAuth 2.0 flow                                    |

Each provider is enabled by setting its environment variables (client ID and secret). The frontend automatically shows buttons for enabled providers.

### Session Cookie

The `session` cookie is `HttpOnly` + `Secure` (issue #1088) and the server is its sole writer — there is no client-side token management. Dead sessions are detected without reading the cookie: the auth-error redirect is mounted only on authenticated surfaces, so any `UNAUTHORIZED` there means "session died". HttpOnly removes the XSS→session-theft path, but `sanitizeEntryHtml` remains security-critical XSS defense (see `src/server/html/CLAUDE.md`).

### Token Scopes & Authorization

Authorization is **fail-closed** for tokens. Four credential types: browser sessions (full access), scoped sessions (compat-API bearer credentials, rejected for full-access use), API tokens (scope-restricted), and OAuth 2.1 access tokens (audience-bound to the MCP endpoint). tRPC procedures are session-only by default — **new endpoints are token-inaccessible until they explicitly opt in** via `scopedProtectedProcedure`. Scope table and enforcement details: `src/server/auth/CLAUDE.md`.

---

## Feed Processing

Details (polling/backoff ladder, WebSub invariants, renewal): `src/server/feed/CLAUDE.md`.

### Feed Types

- **RSS/Atom/JSON**: Standard web feeds fetched via HTTP
- **Email**: Newsletters received via ingest email addresses
- **Saved**: User-saved articles (read-it-later)

### Respectful Fetching

Lion Reader respects server `Cache-Control` headers and conditional-request validators, applies exponential backoff to failing feeds (capped at 7 days; rate-limit responses capped much lower), honors `Retry-After`, and tracks permanent redirects. Per-source plugins can raise the minimum poll interval.

### WebSub Push & Backup Polling

When a feed advertises a hub, we subscribe via WebSub and drop the feed to a 24h backup-poll cadence, trusting the hub to push in real time. Because hubs can silently die, staleness is bounded by a 14-day lease clamp and dead-hub breakage is made visible by a per-hub push-reliability tally (`websub_hub_stats`). Renewals are non-disruptive (row stays `active`, secret never rotates), and a hub that accepts a resubscribe but never verifies is reverted to polling (issue #1079).

### SSRF Protection

All server-side fetches of user-influenced URLs go through `fetchWithSsrfProtection` (`src/server/http/ssrf.ts`), which blocks private/reserved addresses, pins DNS resolution to a vetted address (closing DNS-rebinding TOCTOU), and validates every redirect hop. Mechanics: `src/server/http/CLAUDE.md`.

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
- **Google Reader API** (`/api/greader.php/*`): compatibility layer for Google Reader clients.
- **Wallabag API** (`/api/wallabag/*`): compatibility layer for Wallabag read-it-later clients.
- **MCP** (`/api/mcp`): see [MCP Server](#mcp-server).
- **Webhooks** (`/api/webhooks/*`): Mailgun inbound email, WebSub hub callbacks.

Both compat APIs expose **stored serial** integer ids, never UUID-derived ones — see "Compat API Integer IDs" in `src/server/CLAUDE.md`.

This list is not exhaustive. Other route handlers under `src/app/api/` include `/api/health` (Fly.io/load-balancer health check), `/api/share` (PWA Web Share Target), `/api/admin/session` (admin session helper), and `/api/v1/telemetry` (client telemetry ingest).

### Pagination

Cursor-based pagination everywhere (never offset). Requests take `{ cursor?, limit? }` and responses return `{ items, nextCursor? }`; the cursor is a base64url-encoded keyset tuple. Encoding details — why base64url, and how timestamp cursors preserve microsecond precision via `Temporal` (#680, #683) — are in "Ordering & Pagination Mechanics" in `src/server/CLAUDE.md`.

### Rate Limiting

Token bucket via Redis, per-user, applied only to expensive/abusable operations. Ordinary limits fail open when Redis is down; the per-account password brute-force buckets are the deliberate exception and degrade to an in-memory fallback instead (see `src/server/auth/CLAUDE.md`). The OAuth server endpoints use their own generous per-IP bucket (see `src/server/oauth/CLAUDE.md`).

### Error Responses

Errors use tRPC's standard error envelope, extended by the `errorFormatter` in `src/server/trpc/trpc.ts`: `data` carries the tRPC error code and HTTP status, an optional app-specific `appErrorCode` (set via `createError` in `errors.ts`, e.g. `SIGNUP_CONFIRMATION_REQUIRED`, `INVITE_REQUIRED`, `CONTENT_TOO_LARGE`), and flattened Zod issues in `zodError` when input validation failed.

### Services Layer

Business logic is extracted into reusable service functions in `src/server/services/`: pure functions accepting `db` and parameters, returning plain data objects, shared across tRPC routers, the MCP server, compat APIs, and background jobs. Entry content is sanitized in the services layer so every consumer gets the same guarantee. Module list and conventions: `src/server/CLAUDE.md`.

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
    subscribe/                # Add subscription flow
  save/                       # Bookmarklet landing page (top-level, no auth layout)
  extension/save/             # Browser extension save page
  demo/                       # Interactive demo (no auth required)
```

### Component Architecture

Components live in `src/components/` grouped by domain (`layout/`, `entries/`, `feeds/`, `narration/`, `saved/`, `settings/`, `subscribe/`, `summarization/`, `keyboard/`, `auth/`, `app/`, and generic primitives in `ui/`). Component guidelines, the UI-primitive/icon/color-token reference, and the narration media-controls design are in `src/components/CLAUDE.md`.

---

## MCP Server

Lion Reader exposes functionality to AI assistants via the [Model Context Protocol (MCP)](https://modelcontextprotocol.io/). Two transports are supported:

- **Streamable HTTP** at `POST /api/mcp` — for remote clients such as claude.ai. Authenticated with OAuth 2.1 access tokens (with the `mcp` scope) or legacy API tokens. Runs statelessly inside the Next.js route handler via `WebStandardStreamableHTTPServerTransport`, creating a fresh server+transport pair per request.
- **stdio** (`pnpm mcp:serve`) — for local clients such as Claude Desktop.

Both transports register the same tools (defined once in `src/server/mcp/tools.ts`) and call the same services layer, exactly mirroring the `mcp`-scoped tRPC endpoints: entries list/get/mark-read/star/count, saved-article save/delete/upload, subscriptions list/get, and tag CRUD. See `src/server/mcp/README.md`.

The OAuth 2.1 authorization surface backing remote MCP auth (discovery documents, audience binding, dedicated `MCP_HOST`) is specified in `src/server/oauth/CLAUDE.md`.

---

## Plugin System

Lion Reader has an extensible plugin system (`src/server/plugins/`) that consolidates per-source custom parsing behind a capability-based interface, so adding a content source means writing one self-contained plugin instead of scattering URL checks across core modules. The code is the source of truth: `types.ts` (interfaces), `registry.ts` (hostname-indexed registry), `index.ts` (registration).

The registry indexes plugins by hostname for O(1) lookup, then calls the plugin's `matchUrl(url)`; `findWithCapability(url, capability)` returns the first plugin that matches AND declares the capability:

- **`feed`** capability: transform page URLs to feed URLs, clean entry content, synthesize entry content from parsed-entry metadata (e.g., YouTube's embedded player + description), transform feed titles (e.g., LessWrong GraphQL API), raise the source's minimum polling interval (e.g., YouTube rate-limit avoidance)
- **`savedArticle`** capability: fetch full article content for read-it-later, optionally skipping Readability when the source returns clean HTML

`matchUrl` must be selective, not "any URL on my hosts" — a plugin should only match URLs it can actually handle (e.g. LessWrong `/tag/...` pages must return `false` so the caller falls back to normal fetching).

A plugin can also declare `feedDefaultsToFullContent(feedUrl)`: when it returns true for a feed URL, a **fresh** subscription to that feed starts with `fetch_full_content` on (the frontend then hydrates each entry's full content on open, cached on the shared `entries` row). Used for sources whose feed entries are truncated or drop embedded content — Bluesky's native RSS renders quote posts/images/link cards as a bare placeholder. Matched by hostname + the plugin's predicate on the **feed** URL (not `matchUrl`, which matches entry URLs); a resubscribe keeps the user's stored preference. See `createSubscription` and `feedDefaultsToFullContent` in `src/server/plugins/index.ts`.

### Available Plugins

| Plugin          | Capabilities           | Notes                                                                                                                                                                                                                                                                                                                                                                |
| --------------- | ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **LessWrong**   | `feed`, `savedArticle` | GraphQL API for posts/comments, user profile feeds                                                                                                                                                                                                                                                                                                                   |
| **Google Docs** | `savedArticle`         | Fetch Google Docs content via API                                                                                                                                                                                                                                                                                                                                    |
| **ArXiv**       | `savedArticle`         | Fetch ArXiv paper content                                                                                                                                                                                                                                                                                                                                            |
| **GitHub**      | `savedArticle`         | Fetch GitHub content                                                                                                                                                                                                                                                                                                                                                 |
| **YouTube**     | `feed`, `savedArticle` | Feed: 1h polling floor (per-IP rate limiting); synthesizes entry content (embedded player + description) from Media RSS metadata. SavedArticle: saving a watch/`youtu.be`/shorts/live URL synthesizes the same embed-plus-description body from the watch page's metadata (Readability would fail on the JS watch page)                                              |
| **Bluesky**     | `savedArticle`         | Native RSS works for subscribing but drops post embeds (quote posts, images, link cards, videos) behind a placeholder. SavedArticle hydrates a post via the public AT Protocol appview (`public.api.bsky.app`) — handle→DID, then `getPosts` — and renders the text (with rich-text facets) + embeds as clean HTML. Declares `feedDefaultsToFullContent` (see above) |

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

Docker Compose provides Postgres and Redis for local development. See README for setup instructions (and "Local Services" in the root CLAUDE.md for the no-Docker path).

### Object Storage (S3/Tigris)

An **optional** S3-compatible object store re-hosts external images that would otherwise expire or leak referrers — currently only Google Docs images, which carry short-lived `contentUri` links. `src/server/storage/s3.ts` (`isStorageAvailable`, `fetchAndUploadImage`) signs requests with `aws4fetch` and works against AWS S3 or Fly.io Tigris; `src/server/google/docs.ts` calls it to fetch each image (SSRF-protected, size-limited) and rewrite the document to the re-hosted URL.

Configured via `STORAGE_BUCKET`, `STORAGE_ENDPOINT`, `STORAGE_REGION`, `STORAGE_PUBLIC_URL_BASE` (see `[env]` in `fly.toml`) plus the `STORAGE_ACCESS_KEY_ID` / `STORAGE_SECRET_ACCESS_KEY` secrets. The feature **no-ops when unconfigured**: `isStorageAvailable()` returns false and image re-hosting is skipped, so the rest of the app runs unaffected.

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

Testing conventions, the frontend-testing playbook, and the e2e design points live in `tests/CLAUDE.md`.

### Philosophy

Structure code so business logic is pure and can be unit tested without mocks. **No mocks of internal code** — refactor if mocking is needed. Integration and e2e tests run against real Postgres/Redis (docker-compose), and e2e tests exercise the real SSE pipeline in a browser, asserting the UI updates with zero refetches (the minimal-request invariant from `src/FRONTEND_STATE.md`).

### Test Structure

```
tests/
  unit/           # Fast, no I/O - pure logic tests (frontend cache logic under unit/frontend/)
  integration/    # Requires Docker services - full flow tests
  e2e/            # Playwright browser tests - real app server + Postgres + Redis
```
