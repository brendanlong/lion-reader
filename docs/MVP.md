# Lion Reader MVP

## Overview

The MVP is a functional feed reader that demonstrates the core architecture and provides real value to users. It focuses on the essential read flow: subscribe to feeds, see entries, mark them read.

## MVP Scope

### Included

| Feature | Description |
|---------|-------------|
| **Email/password auth** | Register, login, logout, session management |
| **RSS/Atom feeds** | Subscribe by URL, automatic feed detection |
| **Entry viewing** | List entries, read full content, mark read/unread |
| **Starring** | Star entries for later |
| **Basic UI** | Responsive web app with sidebar navigation |
| **Real-time updates** | SSE for instant entry notifications |
| **Public API** | REST endpoints for third-party clients |

### Excluded from MVP

| Feature | Reason |
|---------|--------|
| OAuth (Google/Facebook/Apple) | Adds complexity, email/password is sufficient |
| Email feed ingestion | Requires email service integration |
| WebSub push | Polling is sufficient for MVP |
| Content cleaning/readability | Pass through original content |
| Entry versioning | Store hash but skip version history |
| Folders/organization | Flat list of feeds is fine initially |
| Full-text search | List/filter is sufficient initially |
| OPML import/export | Manual subscription is fine initially |
| Keyboard shortcuts | Click/tap navigation for MVP |

## Data Model (MVP Subset)

```sql
-- Auth
users (id, email, email_verified_at, password_hash, created_at, updated_at)
sessions (id, user_id, token_hash, created_at, expires_at, revoked_at, last_active_at)

-- Feeds
feeds (id, type, url, title, description, site_url, etag, last_modified_header,
       last_fetched_at, next_fetch_at, consecutive_failures, last_error,
       created_at, updated_at)

entries (id, feed_id, guid, url, title, author, content_original, summary,
         published_at, fetched_at, content_hash, created_at, updated_at)

-- User data
subscriptions (id, user_id, feed_id, custom_title, subscribed_at, unsubscribed_at,
               created_at, updated_at)

user_entry_states (user_id, entry_id, read, starred, read_at, starred_at)

-- Jobs
jobs (id, type, payload, scheduled_for, started_at, completed_at, status,
      attempts, max_attempts, last_error, created_at)
```

Note: Compared to full design, MVP omits:
- `oauth_accounts` table
- `entry_versions` table
- `websub_subscriptions` table
- Several columns (redirect tracking, polling interval override, etc.)

## API Endpoints (MVP)

### Auth
```
POST /v1/auth/register     { email, password } → { user, session }
POST /v1/auth/login        { email, password } → { user, session }
POST /v1/auth/logout       {} → {}
GET  /v1/auth/me           → { user }
```

### Subscriptions
```
GET    /v1/subscriptions              → { items: Subscription[] }
POST   /v1/subscriptions              { url } → { subscription, feed }
GET    /v1/subscriptions/:id          → { subscription, feed }
PATCH  /v1/subscriptions/:id          { customTitle? } → { subscription }
DELETE /v1/subscriptions/:id          → {}
```

### Entries
```
GET  /v1/entries                      { feedId?, unreadOnly?, starredOnly?, cursor?, limit? }
                                      → { items: Entry[], nextCursor? }
GET  /v1/entries/:id                  → { entry }
POST /v1/entries/mark-read            { ids: string[], read: boolean } → {}
POST /v1/entries/mark-all-read        { feedId?, before? } → { count }
POST /v1/entries/:id/star             → {}
DELETE /v1/entries/:id/star           → {}
```

### Feeds
```
GET /v1/feeds/preview                 { url } → { feed: FeedPreview }
```

### Real-time
```
GET /v1/events                        → SSE stream
```

## Frontend Routes (MVP)

```
/                   → Landing page (unauthenticated) or redirect to /all
/login              → Login form
/register           → Registration form

/all                → All entries (unified timeline)
/starred            → Starred entries
/feed/:feedId       → Single feed entries
/entry/:entryId     → Full entry view (optional, could be modal)
/settings           → Account settings
/settings/sessions  → Manage active sessions
/subscribe          → Add subscription
```

## UI Components (MVP)

```
┌─────────────────────────────────────────────────────────────────┐
│  Lion Reader                              [+ Subscribe] [User ▼]│
├──────────────────┬──────────────────────────────────────────────┤
│                  │                                              │
│  All Items (42)  │  ┌─────────────────────────────────────────┐ │
│  Starred         │  │ ○ Entry Title                           │ │
│                  │  │   Feed Name · 2 hours ago               │ │
│  ─────────────── │  │   Preview text of the entry content...  │ │
│                  │  └─────────────────────────────────────────┘ │
│  Feeds           │  ┌─────────────────────────────────────────┐ │
│    Blog A (12)   │  │ ● Entry Title                           │ │
│    Blog B (3)    │  │   Feed Name · 5 hours ago               │ │
│    News C (27)   │  │   Preview text of the entry content...  │ │
│                  │  └─────────────────────────────────────────┘ │
│                  │                                              │
│                  │  [Load more]                                 │
│                  │                                              │
└──────────────────┴──────────────────────────────────────────────┘

● = unread, ○ = read
```

## Implementation Order

### Phase 1: Foundation

**1.1 Project Setup**
- Initialize Next.js project with App Router
- Configure TypeScript (strict mode)
- Set up pnpm, ESLint, Prettier
- Create Dockerfile and docker-compose.yml
- Set up Drizzle ORM with Postgres

**1.2 Database Schema**
- Create MVP schema migrations
- Implement UUIDv7 generation
- Set up seed data for development

**1.3 tRPC Setup**
- Configure tRPC with Next.js
- Set up trpc-openapi for REST endpoints
- Implement error handling middleware

### Phase 2: Authentication

**2.1 Core Auth**
- User registration (email/password)
- Password hashing with argon2
- Session creation and validation
- Login/logout flows

**2.2 Session Management**
- Token generation and hashing
- Redis session cache
- Session revocation
- List active sessions

**2.3 Auth UI**
- Login page
- Registration page
- Protected route middleware

### Phase 3: Feed Management

**3.1 Feed Parser**
- RSS 2.0 parsing
- Atom parsing
- Unified ParsedFeed output
- Feed auto-detection from HTML pages

**3.2 Feed Subscription**
- Subscribe by URL endpoint
- Feed preview endpoint
- Create subscription (find or create feed)
- List/update/delete subscriptions

**3.3 Subscription UI**
- Subscribe dialog/page
- Feed preview before subscribing
- Subscription list in sidebar

### Phase 4: Feed Fetching

**4.1 Job Queue**
- Simple Postgres-based job queue
- Job scheduling (scheduled_for)
- Job execution with retries
- Concurrent job processing

**4.2 Feed Fetcher**
- HTTP fetch with proper headers (If-None-Match, If-Modified-Since)
- Response handling (200, 304, errors)
- Cache header parsing
- Next fetch time calculation

**4.3 Entry Processing**
- Parse entries from feed
- Detect new vs existing entries
- Store entries in database
- Publish new entry events to Redis

**4.4 Background Worker**
- Worker process/thread in app server
- Poll for due jobs
- Execute feed fetches
- Handle failures and retries

### Phase 5: Entry Display

**5.1 Entry Queries**
- List entries for user (with visibility filter)
- Filter by feed, unread, starred
- Cursor-based pagination
- Single entry fetch

**5.2 Entry Actions**
- Mark read/unread (single and bulk)
- Mark all read (with filters)
- Star/unstar

**5.3 Entry UI**
- Entry list component
- Entry list item (title, feed, date, preview)
- Entry content view
- Read/star action buttons
- Infinite scroll loading

### Phase 6: Real-time Updates

**6.1 Redis Pub/Sub**
- Publish events on new entries
- Subscribe to feed channels

**6.2 SSE Endpoint**
- Server-Sent Events route
- User-specific channel subscription
- Heartbeat for connection keepalive

**6.3 Client Integration**
- EventSource connection
- React Query cache invalidation
- Connection status indicator

### Phase 7: Polish

**7.1 UI/UX**
- Responsive design (mobile-friendly)
- Loading states and skeletons
- Error states and retry
- Empty states

**7.2 Settings**
- Account settings page
- Session management UI
- Change password

**7.3 Rate Limiting**
- API rate limiting with Redis
- Rate limit headers in responses

### Phase 8: Deployment

**8.1 Infrastructure**
- Fly.io app configuration
- Postgres database provisioning
- Redis provisioning
- Environment variables

**8.2 CI/CD**
- GitHub Actions for CI
- Automated deployment on merge
- Database migrations in deploy

**8.3 Observability**
- Grafana Cloud setup
- Sentry error tracking
- Basic metrics and logging

## Technical Decisions for MVP

### Libraries

| Purpose | Library | Rationale |
|---------|---------|-----------|
| Framework | Next.js 14+ | App Router, RSC, API routes |
| API | tRPC + trpc-openapi | Type safety, auto REST generation |
| Database | Drizzle ORM | TypeScript-first, good migrations |
| Validation | Zod | Used by tRPC, schema validation |
| Auth | Custom + argon2 + arctic | Full control, battle-tested primitives |
| HTTP Client | Native fetch | Sufficient for our needs |
| XML Parsing | fast-xml-parser | Fast, well-maintained |
| State | TanStack Query | Server state management |
| Styling | Tailwind CSS | Utility-first, fast iteration |
| UI Components | shadcn/ui | Unstyled, accessible components |

### File Structure

```
lion-reader/
├── src/
│   ├── app/                    # Next.js App Router
│   │   ├── (auth)/            # Auth pages
│   │   ├── (app)/             # App pages
│   │   └── api/               # API routes
│   │
│   ├── server/                # Server-side code
│   │   ├── trpc/              # tRPC routers
│   │   │   ├── routers/
│   │   │   ├── trpc.ts        # tRPC instance
│   │   │   └── root.ts        # Root router
│   │   ├── db/                # Database
│   │   │   ├── schema.ts      # Drizzle schema
│   │   │   ├── index.ts       # DB client
│   │   │   └── queries/       # Query helpers
│   │   ├── auth/              # Auth logic
│   │   ├── feed/              # Feed parsing, fetching
│   │   └── jobs/              # Background job processing
│   │
│   ├── lib/                   # Shared utilities
│   │   ├── utils.ts
│   │   └── constants.ts
│   │
│   └── components/            # React components
│       ├── layout/
│       ├── entries/
│       ├── feeds/
│       └── ui/
│
├── drizzle/                   # Migrations
├── tests/
│   ├── unit/
│   └── integration/
├── public/
├── docs/
├── Dockerfile
├── docker-compose.yml
├── fly.toml
└── package.json
```

## Success Criteria

MVP is complete when a user can:

1. Create an account with email/password
2. Subscribe to an RSS or Atom feed
3. See entries from their subscribed feeds
4. Mark entries as read (individually and bulk)
5. Star entries for later
6. See new entries appear in real-time (without refresh)
7. Access their account from the public REST API
8. Access the app from mobile web

## Estimated Effort

| Phase | Effort |
|-------|--------|
| 1. Foundation | Small |
| 2. Authentication | Small |
| 3. Feed Management | Medium |
| 4. Feed Fetching | Medium |
| 5. Entry Display | Medium |
| 6. Real-time Updates | Small |
| 7. Polish | Medium |
| 8. Deployment | Small |

## Post-MVP Priorities

After MVP, in rough priority order:

1. **OAuth login** - Reduce friction for new users
2. **OPML import** - Easy migration from other readers
3. **Keyboard shortcuts** - Power user retention
4. **WebSub support** - Reduce polling load, faster updates
5. **Folders** - Organization for users with many feeds
6. **Full-text search** - Find old entries
7. **Email ingestion** - Newsletter support
8. **Content cleaning** - Better reading experience
