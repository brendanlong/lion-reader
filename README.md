# Lion Reader

A modern, high-performance feed reader designed for scale.

## Overview

Lion Reader is a self-hosted feed reader that supports RSS, Atom, and JSON feeds, with additional support for email-based subscriptions (like Substack newsletters). It's designed for low hosting costs at small scale while being able to handle viral growth.

## Key Features

- **Multiple feed formats**: RSS, Atom, JSON Feed, and email subscriptions
- **Real-time updates**: Instant UI updates when feeds change via SSE
- **Smart polling**: Respects cache headers, adapts to update frequency
- **Push support**: WebSub (PubSubHubbub) for instant updates from supporting feeds
- **Multi-user**: Efficient storage with per-user privacy (users only see entries from after they subscribed)
- **Public API**: Full REST API for third-party clients
- **OAuth support**: Google, Facebook, Apple sign-in alongside email/password

## Tech Stack

- **Frontend**: Next.js (App Router, React Server Components)
- **Backend**: TypeScript, tRPC
- **Database**: PostgreSQL
- **Cache/Pubsub**: Redis
- **Deployment**: Fly.io, Docker
- **Observability**: Grafana Cloud, Sentry

## Documentation

- [Design Document](docs/DESIGN.md) - Architecture, database schema, API design
- [MVP Specification](docs/MVP.md) - MVP scope and implementation plan

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

# Run database migrations (available after task 1.3)
# pnpm db:migrate

# Start development server
pnpm dev
```

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

## License

[TBD]
