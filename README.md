# Lion Reader

A modern, high-performance feed reader designed for scale.

## Overview

Lion Reader is a self-hosted feed reader that supports RSS and Atom feeds. It's designed for low hosting costs at small scale while being able to handle growth.

## Features

- **Feed support** - RSS, Atom, and JSON Feed formats with auto-detection from HTML pages
- **Email subscriptions** - Subscribe to newsletters via custom ingest email addresses
- **Real-time updates** - Server-Sent Events (SSE) and WebSub push support
- **Smart polling** - Respects cache headers with exponential backoff for failed feeds
- **Entry management** - Read/unread tracking, starring, folders/tags
- **Saved articles** - Read-it-later functionality for any URL
- **Audio narration** - Listen to articles with on-device text-to-speech
- **Multi-user** - Per-user privacy (entries visible only after subscription)
- **Authentication** - Email/password and OAuth (Google, Apple)
- **OPML import/export** - Migrate from other readers
- **Keyboard shortcuts** - Vim-style navigation for power users
- **REST API** - Public API for third-party clients
- **Android app** - Native Android client in `android/`
- **Rate limiting** and **error tracking** with Sentry

### Planned Features

- Full-text search
- iOS app
- Offline/PWA support

## Tech Stack

- **Frontend**: Next.js 16 (App Router, React Server Components)
- **Backend**: TypeScript, tRPC with REST API generation
- **Database**: PostgreSQL 16 with Drizzle ORM
- **Cache/Pubsub**: Redis 7
- **Deployment**: Fly.io, Docker
- **Observability**: Sentry for error tracking, structured logging

## Documentation

- [Design Document](docs/DESIGN.md) - Architecture and key design decisions
- [Deployment Guide](docs/features/DEPLOYMENT.md) - Production deployment to Fly.io
- Feature design docs in `docs/features/` (audio narration, email subscriptions, etc.)

## Development

### Prerequisites

- Node.js 20+
- pnpm
- Docker and Docker Compose (for local Postgres and Redis)

### Setup

```bash
# Clone the repository
git clone https://github.com/your-org/lion-reader.git
cd lion-reader

# Install dependencies
pnpm install

# Copy environment variables
cp .env.example .env

# Start local services (Postgres 16 and Redis 7)
docker compose up -d

# Verify services are running
docker compose ps

# Run database migrations
pnpm db:migrate

# Seed the database with test data (optional)
pnpm db:seed

# Start development server
pnpm dev
```

The app will be available at http://localhost:3000.

### Local Services

The development environment uses Docker Compose to run:

| Service  | Port | Description                      |
| -------- | ---- | -------------------------------- |
| Postgres | 5432 | Primary database (PostgreSQL 16) |
| Redis    | 6379 | Cache and pub/sub (Redis 7)      |

**Connection URLs** (configured in `.env`):

- Database: `postgresql://lionreader:lionreader@localhost:5432/lionreader`
- Redis: `redis://localhost:6379`

### Common Commands

```bash
# Start services in background
docker compose up -d

# View service logs
docker compose logs -f

# Stop services (preserves data)
docker compose stop

# Stop and remove containers (preserves volumes)
docker compose down

# Stop and remove everything including data
docker compose down -v

# Check service health
docker compose ps
```

### Testing

```bash
# Unit tests (fast, no I/O)
pnpm test:unit

# Integration tests (requires Docker services)
pnpm test:integration

# Type checking
pnpm typecheck

# Linting
pnpm lint
```

### Background Worker

The background worker fetches feeds on a schedule. It starts automatically when you run `pnpm dev` or `pnpm start`. The worker:

- Polls for due jobs every 5 seconds
- Processes up to 3 feed fetches concurrently
- Respects cache headers for efficient polling
- Implements exponential backoff for failed feeds

You can monitor worker activity in the server logs.

## User Registration

By default, Lion Reader runs in invite-only mode. New users need an invite link to register.

### Environment Variables

| Variable            | Default | Description                                          |
| ------------------- | ------- | ---------------------------------------------------- |
| `ALLOW_ALL_SIGNUPS` | `false` | Set to `true` to allow anyone to register            |
| `ALLOWLIST_SECRET`  | -       | Secret for admin API (required for invite-only mode) |

### Creating Invites

When running in invite-only mode, use the admin API to create invite links:

```bash
# Create an invite (valid for 7 days)
curl -X POST https://your-app/api/trpc/admin.createInvite \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $ALLOWLIST_SECRET" \
  -d '{}'

# Response: {"result":{"data":{"inviteUrl":"https://your-app/register?invite=..."}}}
```

Share the returned URL with the user. Each invite can only be used once.

### Managing Invites

```bash
# List all invites with status (pending/used/expired)
curl -X POST https://your-app/api/trpc/admin.listInvites \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $ALLOWLIST_SECRET" \
  -d '{}'

# Revoke an unused invite
curl -X POST https://your-app/api/trpc/admin.revokeInvite \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $ALLOWLIST_SECRET" \
  -d '{"inviteId":"<uuid>"}'
```

## Production Deployment

Lion Reader is configured for deployment to [Fly.io](https://fly.io). See the [Deployment Guide](docs/DEPLOYMENT.md) for detailed instructions.

Quick start:

```bash
# Install Fly CLI
curl -L https://fly.io/install.sh | sh

# Login and launch
fly auth login
fly launch --no-deploy

# Provision database and Redis
fly postgres create
fly postgres attach <your-postgres-app>
fly redis create

# Deploy
fly deploy
```

## API Documentation

Lion Reader provides a REST API for third-party clients. Key endpoints:

| Method | Endpoint                | Description                      |
| ------ | ----------------------- | -------------------------------- |
| POST   | `/v1/auth/register`     | Create account                   |
| POST   | `/v1/auth/login`        | Login                            |
| GET    | `/v1/subscriptions`     | List subscriptions               |
| POST   | `/v1/subscriptions`     | Subscribe to feed                |
| GET    | `/v1/entries`           | List entries                     |
| POST   | `/v1/entries/mark-read` | Mark entries read                |
| GET    | `/v1/events`            | SSE stream for real-time updates |

See [MVP Specification](docs/MVP.md) for the complete API reference.

## License

[TBD]
