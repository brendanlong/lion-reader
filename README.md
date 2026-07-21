# Lion Reader

An AI-native, all-in-one reader that unifies RSS/Atom/JSON feeds, email newsletters, and read-later into one fast, self-hostable app. Try the [interactive demo](https://lionreader.com/demo) — no signup required.

Read more: [Claude Wrote Me a 400-Commit RSS Reader App](https://www.brendanlong.com/claude-wrote-me-a-400-commit-rss-reader-app.html) and the follow-up, [My RSS Reader is Done](https://www.brendanlong.com/my-rss-reader-is-done.html).

## What makes it different

- **AI-native, not AI-bolted-on** — Connect Claude and other assistants directly to your reader over the [Model Context Protocol (MCP)](docs/DESIGN.md#mcp-server) to list, search, save, star, and mark entries read on your behalf. On-demand article summaries via Claude (never auto-summarized), plus text-to-speech narration with synchronized paragraph highlighting.
- **Everything in one place** — Feeds, email newsletters, and read-later side by side. Save any page via browser extensions, a bookmarklet, a Discord bot, your phone's share menu (PWA), the MCP/REST APIs, or Markdown/Word/HTML uploads — with enhanced extraction for arXiv, GitHub, Google Docs, and LessWrong.
- **Obsessively fast** — Real-time updates are patched directly into the list you're reading (no refetch, no re-render jank), in-app navigation is served from cache with zero server round-trips, and the backend is tuned for sub-100ms page loads on cheap cloud hosts (sub-20ms on desktop hardware). See [Frontend State](src/FRONTEND_STATE.md) and [Design](docs/DESIGN.md#frontend-architecture).
- **Free, open source, and self-hostable** — No ads, no data selling, no third-party analytics. Deploy with Docker; runs affordably at small scale and scales horizontally.

## Features

- **Feed support** - RSS, Atom, and JSON Feed with auto-detection from HTML pages
- **Email subscriptions** - Subscribe to newsletters via custom ingest email addresses
- **Saved articles / read-later** - Save any URL (extensions, bookmarklet, Discord bot, PWA share, MCP/API, file upload), with source plugins for arXiv, GitHub, Google Docs, and LessWrong
- **AI integration** - MCP server for AI assistants, on-demand Claude summaries, and text-to-speech narration with synced highlighting
- **Real-time updates** - Server-Sent Events (SSE) patched directly into the cache, plus WebSub push support
- **Smart polling** - Respects cache headers, with exponential backoff for failed feeds
- **Entry management** - Read/unread tracking, starring, tags, full-text search
- **Full content fetching** - Optionally fetch complete article content from the source page
- **Multi-user with privacy by default** - Entries are only visible if fetched after you subscribed
- **Authentication** - Email/password and OAuth (Google, Apple, Discord)
- **OPML import/export** - Migrate from other readers
- **Keyboard shortcuts** - Vim-style navigation
- **PWA** - Installable app with offline support
- **APIs** - REST API (OpenAPI spec at `/api/openapi`), Google Reader and Wallabag compatibility APIs, MCP server for AI assistants
- **Observability** - Prometheus metrics, structured logging, Sentry error tracking

## Tech Stack

- **Frontend**: Next.js 16 (App Router), React Query via tRPC
- **Backend**: TypeScript, tRPC (REST API generated via `trpc-to-openapi`)
- **Database**: PostgreSQL 16 with Drizzle ORM
- **Cache/Pubsub**: Redis 7
- **Deployment**: Fly.io, Docker
- **Observability**: Sentry, Prometheus, structured logging

## Documentation

- [Design Document](docs/DESIGN.md) - Architecture and key design decisions
- [Deployment Guide](docs/DEPLOYMENT.md) - Production deployment to Fly.io

## Development

### Prerequisites

- Node.js 26+
- pnpm
- Docker and Docker Compose (for local Postgres and Redis)

### Setup

```bash
pnpm install

# Copy environment variables
cp .env.example .env

# Start Postgres 16 and Redis 7
docker compose up -d

# Run database migrations
pnpm db:migrate

# Seed the database with test data (optional)
pnpm db:seed

# Start development server (app + worker)
pnpm dev
```

The app will be available at http://localhost:3000. Connection URLs are configured in `.env`:

- Database: `postgresql://lionreader:lionreader@localhost:5432/lionreader`
- Redis: `redis://localhost:6379`

### Testing

```bash
pnpm typecheck         # Type checking
pnpm lint              # Linting
pnpm test:unit         # Unit tests (fast, no I/O)
pnpm test:integration  # Integration tests (requires Docker services)
pnpm test:e2e          # Playwright browser tests (requires Docker services)
```

### Background Worker

The worker fetches feeds on a schedule. It starts automatically with `pnpm dev` or `pnpm start`, polls for due jobs every 5 seconds, and processes up to 5 jobs concurrently.

### Profiling

Build for production, then run with the flame profiler:

```bash
NODE_ENV=production pnpm build:all

# Profile the worker
NODE_ENV=production npx @platformatic/flame run --sourcemap-dirs=dist/ dist/worker.js

# Profile the Next.js server
NODE_ENV=production npx @platformatic/flame run --sourcemap-dirs=.next/ node_modules/next/dist/bin/next start
```

## User Registration

By default, Lion Reader runs in invite-only mode. New users need an invite link to register.

| Variable                          | Default | Description                                                                                  |
| --------------------------------- | ------- | -------------------------------------------------------------------------------------------- |
| `ALLOWED_SIGNUP_PROVIDERS`        | all     | Comma-separated providers (`email,google,apple,discord`) allowed to sign up _with_ an invite |
| `ALLOWED_PUBLIC_SIGNUP_PROVIDERS` | none    | Subset allowed to sign up _without_ an invite. Empty = fully invite-only                     |
| `ALLOWLIST_SECRET`                | -       | Secret for admin API (required whenever any provider is invite-only)                         |

Manage invites through the admin API (each invite is single-use, valid for 7 days):

```bash
# Create an invite; response contains inviteUrl
curl -X POST https://your-app/api/trpc/admin.createInvite \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $ALLOWLIST_SECRET" -d '{}'

# List invites with status (pending/used/expired)
curl -X POST https://your-app/api/trpc/admin.listInvites \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $ALLOWLIST_SECRET" -d '{}'

# Revoke an unused invite
curl -X POST https://your-app/api/trpc/admin.revokeInvite \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $ALLOWLIST_SECRET" -d '{"inviteId":"<uuid>"}'
```

## Email Newsletter Subscriptions

Users can create ingest email addresses (Settings → Email, max 5 per user) and use them to subscribe to newsletters. Each sender becomes a separate feed alongside RSS subscriptions. Unsubscribing uses RFC 2369/8058 List-Unsubscribe headers where available and blocks future emails from the sender.

Inbound email is delivered by [Mailgun](https://www.mailgun.com) receiving routes:

1. Point MX records for your ingest domain at Mailgun and verify the domain
2. Create a Mailgun route that forwards matching messages to `https://your-app/api/webhooks/email/mailgun` (enable "Store and notify")
3. Configure Lion Reader:

| Variable                      | Default                 | Description                                                    |
| ----------------------------- | ----------------------- | -------------------------------------------------------------- |
| `INGEST_EMAIL_DOMAIN`         | `ingest.lionreader.com` | Domain for ingest email addresses                              |
| `MAILGUN_WEBHOOK_SIGNING_KEY` | -                       | Mailgun webhook signing key (Sending → Webhooks); **required** |

The webhook verifies Mailgun's HMAC-SHA256 signature; requests with invalid signatures are rejected.

## Production Deployment

Lion Reader is configured for deployment to [Fly.io](https://fly.io) with three process groups (`app`, `worker`, `discord`), canary deploys, and migrations run automatically in the release command. See the [Deployment Guide](docs/DEPLOYMENT.md) for full provisioning instructions.

## APIs

- **REST API**: `/api/v1/*`, generated from the tRPC procedures. The OpenAPI 3.0 spec is served at `/api/openapi` (usable with Swagger UI, Postman, etc.). Real-time updates via SSE at `/api/v1/events`.
- **Google Reader compatibility**: `/api/greader.php/*` for Google Reader-protocol clients.
- **Wallabag compatibility**: `/api/wallabag/*` for Wallabag read-it-later clients.
- **MCP server**: `/api/mcp` (Streamable HTTP with OAuth 2.1 or scoped API tokens) and a local stdio transport via `pnpm mcp:serve`. See the [Design Document](docs/DESIGN.md#mcp-server) for the tool list and setup.

## License

[TBD]
