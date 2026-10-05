# Lion Reader Design Document

Architecture and the decisions behind it. The rules for working inside each subsystem live in its per-directory `CLAUDE.md`, linked from each section. Flow diagrams are in [`docs/diagrams/`](diagrams/) (render with the [D2 CLI](https://d2lang.com/) or [playground](https://play.d2lang.com/)).

---

## System Architecture

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
```

The app, worker, and Discord bot are separate, independently scaled Fly process groups; the worker is not embedded in the app servers. Background jobs use a Postgres-based queue (`src/server/jobs/`).

### Design Principles

1. **Stateless app servers**: All state in Postgres/Redis, enabling horizontal scaling
2. **Efficient data sharing**: Feed/entry data deduplicated across users
3. **Privacy by default**: users never see content from before they subscribed (see Data Model)
4. **Graceful degradation**: Handle misbehaving feeds, rate limits, and failures
5. **Observable**: Comprehensive logging, metrics, and error tracking

---

## Data Model

Canonical `feeds`/`entries` rows are shared across users; `subscriptions` and `user_entries` hold each user's relationship and read/star state. Keys are UUIDv7. The schema is `migrations/schema.sql`; the invariants are in `src/server/CLAUDE.md`. The decisions that shape it:

- **Entry visibility is decided at insert time**: a user sees an entry only if a `user_entries` row exists, and rows are only created for what a feed currently contains when the user subscribes or a fetch runs. That — not a timestamp rule in a view — is what keeps pre-subscription content private.
- **Unread counts are denormalized** onto trigger-maintained counters, so badges are arithmetic over subscriptions, never entry scans; a daily job repairs (and loudly reports) drift.
- **Conflicting updates resolve to the newest user intent**: read/star carry per-field last-writer-wins watermarks, and `updated_at` moves only on a real change so re-asserts don't churn delta sync.
- **Soft deletes** for subscriptions (`unsubscribed_at`), so resubscribing restores read state.
- **Changed content overwrites** the previous version, detected by `content_hash`.

---

## Authentication

Custom auth from established primitives: `openid-client` (Google/Apple/Discord sign-in, each enabled by its env vars), `argon2` (passwords), and token sessions stored in Postgres behind a Redis cache. Details: `src/server/auth/CLAUDE.md`; the OAuth 2.1 server that issues tokens to MCP clients and the native app: `src/server/oauth/CLAUDE.md`.

---

## Feed Processing

Feed types are web (RSS/Atom/JSON), email (newsletters to per-user ingest addresses), saved (read-it-later), and collection (a per-user list of articles from any of the others, #1806). A collection is a subscription like any feed, so it is tagged, renamed, counted and shown the same way; its articles are referenced, not copied, so read state stays shared. We fetch respectfully — honoring `Cache-Control`, conditional requests and `Retry-After`, backing off failing feeds up to 7 days, and tracking permanent redirects. Feeds that advertise a WebSub hub get pushes and drop to a daily backup poll. Rules: `src/server/feed/CLAUDE.md`.

Per-source behavior (YouTube, LessWrong, Bluesky, Google Docs, …) lives in capability-based plugins (`src/server/plugins/`), so adding a source means writing one self-contained plugin instead of scattering URL checks through core modules.

---

## Real-time Updates

Workers publish to Redis; each app process forwards events over SSE; the client writes them straight into its local store and caches without refetching ([sse-cache-updates.d2](diagrams/sse-cache-updates.d2), `src/FRONTEND_STATE.md`).

- **Two channel patterns**, so servers receive only what they need: `feed:{feedId}:events` for a web feed's entries (one publish per fetch reaches every subscriber), and `user:{userId}:events` for everything with a single recipient — per-user state, and email and saved entries. Event types are in `src/server/redis/pubsub.ts`.
- **One connection per tab** to `/api/v1/events`; if SSE is unavailable (a 503), the client polls the sync endpoint instead.
- **One Redis subscriber per app process**, with channel subscriptions ref-counted across SSE connections, so Redis connections don't grow with users.

---

## API Design

**Subscriptions, not feeds, are the user-facing identifier.** Feeds are shared internally, but clients see "their subscriptions" with feed metadata flattened in, and filter entries by `subscriptionId`. The `feeds` router is pre-subscription only (preview, discover).

The same services back several surfaces under `src/app/api/`: the browser tRPC endpoint (`/api/trpc`); a REST API (`/api/v1/*`) generated from tRPC `openapi` meta, spec at `/api/openapi`; the Google Reader and Wallabag compatibility APIs; MCP (`/api/mcp`); and webhooks (Mailgun, WebSub).

- **Pagination** is cursor-based everywhere: `{ cursor?, limit? }` in, `{ items, nextCursor? }` out.
- **Rate limits** (Redis token buckets) apply only to expensive or abusable operations (failure behavior: `src/server/auth/CLAUDE.md`).
- **Errors** use tRPC's envelope; `errorFormatter` in `src/server/trpc/trpc.ts` adds an optional app-specific `appErrorCode` and flattened Zod issues.

---

## Frontend Architecture

**The app is a client-side SPA after the first load.** Next.js App Router renders the initial page; after hydration, `ClientLink` navigates with `history.pushState` and `AppRouter` (`src/components/app/AppRouter.tsx`) picks what to render from the pathname, served from the React Query cache and the local entry store, which SSE keeps fresh. Navigation costs no server requests. Native App Router navigation was rejected (#872): per-navigation RSC fetches defeat the SSE-fed cache. The `page.tsx` files exist to prefetch data for the initial load. Routes split into two root layouts, `(spa)` and `(public)` (`src/CLAUDE.md`).

---

## MCP Server

AI assistants reach Lion Reader over [MCP](https://modelcontextprotocol.io/): Streamable HTTP at `POST /api/mcp` (stateless, a fresh server per request; OAuth 2.1 or API tokens) and stdio (`pnpm mcp:serve`) for local clients. Both register the tools in `src/server/mcp/tools.ts`, which call the same services as the `mcp`-scoped tRPC endpoints. See `src/server/mcp/README.md`.

---

## Infrastructure

`fly.toml` is the source of truth for regions, process groups, machine sizes, and the release command; `docs/DEPLOYMENT.md` is the runbook. Postgres is **unmanaged** Fly Postgres Flex, so we own its upgrades, backups and monitoring (`docs/fly-postgres-ops.md`). Redis is Upstash.

- **Migrations run before the canary deploy**, so every migration must work with the previous release (`migrations/CLAUDE.md`). For one that can't, an admin turns on **maintenance mode** (`/admin` → Status), which stops every process group from touching the database ("Site Status" in `src/server/CLAUDE.md`).
- **Object storage is optional** (S3 or Tigris, `src/server/storage/s3.ts`): it re-hosts expiring external images (Google Docs) and caches the demo's recorded narration. Without it, images stay at their source and each machine synthesizes demo narration once into its disk cache.

---

## Observability

Sentry for errors, Prometheus (`prom-client`, `/metrics` per process) for metrics, structured JSON logs.

Alerting uses [healthchecks.io](https://healthchecks.io) dead-man's switches (declared in [`terraform/`](../terraform/README.md)), one **separate** check per signal so a dead worker is distinguishable from a fetch regression:

| Check                | Env var                     | Pinged by                            | Signals                                                             |
| -------------------- | --------------------------- | ------------------------------------ | ------------------------------------------------------------------- |
| Feed fetch health    | `FEED_HEALTH_HEARTBEAT_URL` | `monitor_feed_health` (every 15 min) | `/fail` when no feed fetched successfully lately (`feed/health.ts`) |
| Worker liveness      | `WORKER_HEARTBEAT_URL`      | worker process (every 1 min)         | `/fail` if the job loop wedges; silence = worker dead               |
| Discord bot liveness | `DISCORD_BOT_HEARTBEAT_URL` | discord-bot process (every 5 min)    | silence = bot dead or crash-looping                                 |

Each is optional (no URL, no pings).
