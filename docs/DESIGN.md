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

For detailed feature designs, see the docs in `docs/features/`.

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
│  ┌─────────┐  │     │               │     │               │
│  │ Worker  │  │     │               │     │               │
│  │ process │  │     │               │     │               │
│  └─────────┘  │     │               │     │               │
└───────┬───────┘     └───────┬───────┘     └───────┬───────┘
        │                     │                     │
        └──────────┬──────────┴──────────┬──────────┘
                   │                     │
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
| **Discord Bot**   | Save articles via emoji reactions in Discord          |
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

- **user_feeds** - Subscriptions with feed metadata merged, using subscription ID as the primary key
- **visible_entries** - Entries with visibility rules applied, including subscription context

See `docs/features/subscription-centric-api.md` for design details.

### Key Design Decisions

**Entry Visibility**: Visibility is enforced at query time by the `visible_entries` view, which requires a `user_entries` row to exist for the `(user, entry)` pair AND that the entry is either from an active subscription (`subscription.unsubscribed_at IS NULL`), is starred, or is a saved article (saved articles live in a per-user feed with no subscription row, so their `user_entries` row alone grants visibility). The predicate is fail-closed: a `user_entries` row whose entry matches no subscription is hidden unless starred/saved. The existence of the `user_entries` row is the durable record of visibility.

The `user_entries` rows are created outside the view at:

- **Subscribe time**: rows are inserted for entries present in the feed's most recent fetch (`entries.last_seen_at = feeds.last_entries_updated_at`), so a new subscriber sees current feed contents but not arbitrarily old entries. See `createSubscription` in `src/server/services/subscriptions.ts`.
- **Fetch time**: when a feed fetch produces new entries, rows are created for that feed's active subscribers. See `createUserEntriesForFeed` in `src/server/feed/entry-processor.ts`.

The older `entry.fetched_at >= subscription.subscribed_at` rule was a one-time backfill applied in migration `0007_user_entries_visibility.sql`; it is **not** enforced by the view. This insert-time gating is what prevents information leakage when users subscribe to feeds that may have contained private content before they subscribed.

**Soft Deletes**: Subscriptions use `unsubscribed_at` for soft delete, allowing users to resubscribe and maintain their read state.

**Content Change Detection**: Entries store a `content_hash` to detect when content changes on the source feed. Updated content overwrites the previous version.

**UUIDv7 Ordering**: Since UUIDv7 is time-ordered, `ORDER BY id DESC` gives us reverse chronological order without needing a separate timestamp column for sorting.

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
5. Update `last_active_at` asynchronously

### Token Format

Session tokens are 32 random bytes, base64url encoded. We store SHA-256 hash in database (never the raw token).

### Token Scopes & Authorization

Authorization is **fail-closed** for tokens. There are three credential types:

- **Browser sessions**: full access. Scopes do not apply (`scopes` is a token-only concept).
- **API tokens** (`api_tokens`, used by extensions/integrations and the legacy MCP path): restricted to their granted scopes.
- **OAuth 2.1 access tokens**: audience-bound to the MCP endpoint only (see below).

Available scopes (`API_TOKEN_SCOPES` / `OAUTH_SCOPES`):

| Scope         | Grants                                                                                                             |
| ------------- | ------------------------------------------------------------------------------------------------------------------ |
| `mcp`         | The MCP tool surface: entries list/get/mark-read/star/count, subscriptions list/get, tag CRUD, saved delete/upload |
| `saved:write` | Saving articles (`saved.save`) only                                                                                |

Enforcement (`src/server/trpc/trpc.ts`):

- `protectedProcedure` / `confirmedProtectedProcedure` (and their `expensive*` variants) are **session-only** — token auth is rejected with `FORBIDDEN`. This protects account-management and other non-MCP endpoints (sessions, password, preferences, ingest addresses, blocked senders, OPML import, narration, summarization, feed stats, broken feeds, feed preview/discover, subscription create/update/delete/import/export, `entries.markAllRead`, `entries.fetchFullContent`) by default.
- `scopedProtectedProcedure(scope | scope[])` opts an endpoint into token access; a token must hold at least one of the listed scopes (sessions bypass). The `mcp`-scoped endpoints mirror the MCP tools exactly; `saved.save` accepts `saved:write` or `mcp`.

Because the default is session-only, **new endpoints are token-inaccessible until they explicitly opt in**.

OAuth access tokens are validated only at `POST /api/mcp` (not in the main tRPC/REST context), where the `mcp` scope and the RFC 8707 `resource`/audience binding are both enforced — a token minted for a different resource is rejected. `/api/mcp` also requires signup confirmation (ToS/Privacy/EU agreement) for both OAuth and API tokens, mirroring `confirmedProtectedProcedure` on the tRPC surface.

The audience binding is enforced on both sides:

- **Mint time** (`/oauth/authorize`): the requested `resource` is validated against this server's canonical resource identifier (`getProtectedResourceMetadata().resource`); a mismatch is rejected with `invalid_target`. When `resource` is omitted, it defaults to the canonical identifier so every issued token is audience-bound. Comparison (`isResourceForThisServer`) ignores trailing slashes and is case-insensitive for scheme/host.
- **Use time** (`/api/mcp`): the token's stored `resource` must match the canonical identifier. Only legacy tokens issued before audience binding may have a null `resource`, which is still accepted (they expire within an hour).

Dynamic Client Registration (`/oauth/register`) is open per RFC 7591 but rate-limited; it stores only the supported subset of requested scopes and rejects registration if none are recognized (it never falls back to "all scopes").

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
   - 429 Too Many Requests: respect `Retry-After`
   - 4xx/5xx: increment failures, backoff
5. Calculate `next_fetch_at` based on Cache-Control (10min with cache hint, 60min default min, 7day max)

### Feed Types

- **RSS/Atom/JSON**: Standard web feeds fetched via HTTP
- **Email**: Newsletters received via ingest email addresses
- **Saved**: User-saved articles (read-it-later)

### Respectful Fetching

Lion Reader respects server Cache-Control headers, Retry-After directives, and HTTP 429 responses. Exponential backoff is applied for failed fetches.

### SSRF Protection

All server-side fetches that target user-influenced URLs (feed preview/discover, feed fetching, full-content fetching, WebSub hub callbacks) are guarded against Server-Side Request Forgery to private/internal networks. The shared helper `fetchWithSsrfProtection(url, init)` in `src/server/http/ssrf.ts` performs the fetch and:

1. Rejects literal private/reserved IP hosts up front (e.g. `http://169.254.169.254/`, `http://127.0.0.1/`, decimal-encoded IPs). undici skips the custom DNS lookup for IP literals, so they must be checked here.
2. Attaches a custom undici dispatcher whose DNS `lookup` resolves the hostname, blocks if **any** resolved address is private, and connects only to the vetted address — closing the DNS-rebinding TOCTOU gap. Because `fetch` reuses the dispatcher, redirect targets are validated too.

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

| Channel Pattern        | Events                                                                                                                                                                            |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `feed:{feedId}:events` | `new_entry`, `entry_updated`                                                                                                                                                      |
| `user:{userId}:events` | `subscription_created`, `subscription_updated`, `subscription_deleted`, `entry_state_changed`, `tag_created`, `tag_updated`, `tag_deleted`, `import_progress`, `import_completed` |

When a user subscribes to a new feed, the SSE connection dynamically subscribes to that feed's channel.

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

See `docs/features/subscription-centric-api.md` for full design.

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

### Pagination

Cursor-based pagination everywhere:

- Request: `{ cursor?: string, limit?: number }`
- Response: `{ items: T[], nextCursor?: string }`
- Cursor is base64-encoded UUIDv7 (gives us ordering)

### Rate Limiting

Token bucket via Redis, per-user. Different buckets for different operations (e.g., search is more limited than reads).

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

| Service            | Functions                                                                                                                                                                                          |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `entries.ts`       | `listEntries`, `getEntry`, `getEntries`, `selectFullEntry`/`toFullEntry` (sanitized read path), `markEntriesRead`, `markAllEntriesRead`, `updateEntryStarred`, `countEntries`, `countTotalEntries` |
| `subscriptions.ts` | `listSubscriptions`, `getSubscription`, `createSubscription`                                                                                                                                       |
| `saved.ts`         | `saveArticle`, `deleteSavedArticle`, `uploadArticle`, `createUploadedArticle`                                                                                                                      |
| `tags.ts`          | `listTags`, `createTag`, `updateTag`, `deleteTag`                                                                                                                                                  |
| `counts.ts`        | `getEntryRelatedCounts`, `getBulkEntryRelatedCounts`, `getNewEntryRelatedCounts`, `getSubscriptionDeletionCounts`                                                                                  |
| `entry-filters.ts` | `buildEntryFeedFilter`, `buildEntryFilterConditions`, `buildTaggedFeedIdsSubquery` - shared filter construction                                                                                    |
| `narration.ts`     | Text-to-speech operations                                                                                                                                                                          |
| `full-content.ts`  | `fetchFullContent`, `fetchAndStoreFullContent` - fetch, sanitize, and persist full article content                                                                                                 |
| `summarization.ts` | AI-powered article summarization                                                                                                                                                                   |
| `users.ts`         | `deleteUser` - account deletion                                                                                                                                                                    |
| `retention.ts`     | `runRetentionCleanup` - data retention background job                                                                                                                                              |

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

See `docs/features/client-side-routing.md` for the full design rationale and the
evaluation against native App Router navigation (issue #872).

### Route Structure

```
app/
  (auth)/                     # Login, register, forgot password
  (app)/                      # Main app (requires auth)
    all/                      # All entries timeline
    starred/                  # Starred entries
    saved/                    # Saved articles
    uncategorized/            # Entries from untagged subscriptions
    subscription/[id]/        # Single subscription entries (uses subscription ID)
    tag/[tagId]/              # Entries filtered by tag
    settings/                 # User settings
      appearance/             # Theme, font, text size
      sessions/               # Active session management
      api-tokens/             # API token management
      email/                  # Newsletter ingest addresses
      blocked-senders/        # Blocked email senders
      broken-feeds/           # Feeds with fetch failures
      feed-stats/             # Per-feed statistics
      integrations/           # Integration settings
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

Lion Reader has an extensible plugin system for integrating with external content sources.

### Architecture

Plugins are registered in `src/server/plugins/registry.ts` and declare capabilities:

- **`feed`** capability: Transform feed URLs, clean entry content (e.g., LessWrong GraphQL API)
- **`savedArticle`** capability: Fetch and process content from URLs (e.g., Google Docs, ArXiv)

### Available Plugins

| Plugin          | Capabilities   | Description                                        |
| --------------- | -------------- | -------------------------------------------------- |
| **LessWrong**   | `feed`         | GraphQL API for posts/comments, user profile feeds |
| **Google Docs** | `savedArticle` | Fetch Google Docs content via API                  |
| **ArXiv**       | `savedArticle` | Fetch ArXiv paper content                          |
| **GitHub**      | `savedArticle` | Fetch GitHub content                               |

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
