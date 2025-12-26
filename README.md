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
- Docker (for local Postgres and Redis)

### Setup

```bash
# Install dependencies
pnpm install

# Start local services
docker-compose up -d

# Run database migrations
pnpm db:migrate

# Start development server
pnpm dev
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
