# Lion Reader

A modern, high-performance feed reader designed for low hosting costs at small scale while being able to handle growth.

## Features

- **Feed support** - RSS, Atom, and JSON Feed with auto-detection from HTML pages
- **Email subscriptions** - Subscribe to newsletters via custom ingest email addresses
- **Real-time updates** - Server-Sent Events (SSE) and WebSub push support
- **Smart polling** - Respects cache headers, with exponential backoff for failed feeds
- **Entry management** - Read/unread tracking, starring, tags, full-text search
- **Saved articles** - Read-it-later for any URL, with source plugins (LessWrong, Google Docs, ArXiv, GitHub)
- **Full content fetching** - Optionally fetch complete article content from the source page
- **Audio narration** - On-device text-to-speech
- **AI summarization** - Optional article summaries
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
