# Lion Reader MVP Implementation Checklist

Each task below is designed to be a self-contained PR. Complete them in order.

ALWAYS read @docs/MVP.md and @docs/DESIGN.md before starting.

## Phase 1: Foundation

### 1.1 Project Scaffolding

- [x] **Initialize Next.js project with TypeScript**
  - Create Next.js 14+ app with App Router
  - Configure TypeScript in strict mode
  - Set up pnpm as package manager
  - Configure ESLint with recommended rules
  - Configure Prettier for code formatting
  - Add basic scripts to package.json (dev, build, start, lint, typecheck)
  - Set up Husky + lint-staged for pre-commit hooks

### 1.2 Docker and Local Development

- [x] **Set up Docker for local development**
  - Create docker-compose.yml with Postgres 16 and Redis 7
  - Create .env.example with required environment variables
  - Document local setup in README.md
  - Verify services start correctly

### 1.3 Database Setup

- [x] **Set up Drizzle ORM and MVP schema**
  - Install and configure Drizzle ORM
  - Implement UUIDv7 generation utility (TypeScript)
  - Create MVP schema migrations:
    - users table
    - sessions table
    - feeds table
    - entries table
    - subscriptions table
    - user_entry_states table
    - jobs table
  - Add db:migrate and db:generate scripts
  - Create seed script for development data

### 1.4 tRPC Setup

- [x] **Configure tRPC with Next.js**
  - Install tRPC and dependencies
  - Set up tRPC context with session handling
  - Create root router structure
  - Set up trpc-openapi for REST endpoint generation
  - Implement error handling middleware
  - Create tRPC client for frontend

## Phase 2: Authentication

### 2.1 Core Auth Backend

- [x] **Implement user registration and password auth**
  - Install argon2 for password hashing
  - Create auth router with register procedure
  - Create auth router with login procedure
  - Implement password validation rules
  - Add email format validation with Zod

### 2.2 Session Management

- [x] **Implement session creation and validation**
  - Generate secure session tokens (32 random bytes, base64url)
  - Store SHA-256 hash of tokens in database
  - Create session validation middleware
  - Implement logout (session revocation)
  - Add session expiry handling
  - Set up Redis session cache (5 min TTL)

### 2.3 Auth API Completion

- [x] **Complete auth API endpoints**
  - GET /v1/auth/me - return current user
  - GET /v1/users/me/sessions - list active sessions
  - DELETE /v1/users/me/sessions/:id - revoke session
  - Update last_active_at on session use

### 2.4 Auth UI

- [x] **Create authentication pages**
  - Create (auth) route group with centered layout
  - Build login page with form
  - Build registration page with form
  - Implement protected route middleware
  - Add redirect logic (unauth → login, auth → /all)
  - Handle auth errors and display messages

## Phase 3: Feed Management

### 3.1 Feed Parser - RSS

- [x] **Implement RSS 2.0 feed parsing**
  - Install fast-xml-parser
  - Define ParsedFeed and ParsedEntry interfaces
  - Implement RSS 2.0 parser
  - Handle common RSS quirks and edge cases
  - Write unit tests for RSS parsing

### 3.2 Feed Parser - Atom

- [x] **Implement Atom feed parsing**
  - Implement Atom 1.0 parser
  - Handle Atom-specific elements (content vs summary, link relations)
  - Write unit tests for Atom parsing
  - Create unified parser that auto-detects format

### 3.3 Feed Auto-Discovery

- [x] **Implement feed discovery from HTML pages**
  - Parse HTML to find link[rel="alternate"] tags
  - Support RSS and Atom type detection
  - Handle relative URLs
  - Write unit tests for discovery

### 3.4 Subscriptions API

- [x] **Implement subscription endpoints**
  - POST /v1/subscriptions - subscribe by URL (find or create feed)
  - GET /v1/subscriptions - list user's subscriptions
  - GET /v1/subscriptions/:id - get single subscription
  - PATCH /v1/subscriptions/:id - update custom title
  - DELETE /v1/subscriptions/:id - unsubscribe (soft delete)

### 3.5 Feed Preview API

- [x] **Implement feed preview endpoint**
  - GET /v1/feeds/preview?url=... - fetch and parse without saving
  - Return feed title, description, site URL, sample entries
  - Handle errors gracefully (invalid URL, not a feed, etc.)

### 3.6 Subscription UI

- [x] **Create subscription management UI**
  - Build subscribe page/dialog with URL input
  - Show feed preview before confirming subscription
  - Build sidebar with feed list and unread counts
  - Add unsubscribe confirmation dialog

## Phase 4: Feed Fetching

### 4.1 Job Queue

- [x] **Implement Postgres-based job queue**
  - Create job creation utility with scheduling
  - Implement job claiming with row locking (SELECT FOR UPDATE SKIP LOCKED)
  - Add job completion and failure handling
  - Implement retry logic with exponential backoff
  - Write integration tests for job queue

### 4.2 Feed Fetcher

- [x] **Implement HTTP feed fetching**
  - Fetch with proper headers (If-None-Match, If-Modified-Since)
  - Handle 200 OK - parse feed content
  - Handle 304 Not Modified - update timestamps only
  - Handle redirects (track permanent redirects)
  - Handle errors (4xx, 5xx, timeouts)
  - Parse cache headers (Cache-Control, ETag, Last-Modified)
  - Write unit tests for cache header parsing

### 4.3 Next Fetch Scheduling

- [x] **Implement next fetch time calculation**
  - Respect Cache-Control max-age (within bounds: 1 min - 7 days)
  - Default to 15 minutes when no cache headers
  - Implement exponential backoff for failures
  - Cap consecutive failures at 10 (then max backoff)
  - Write unit tests for scheduling logic

### 4.4 Entry Processing

- [x] **Implement entry storage and deduplication**
  - Parse entries from fetched feed
  - Generate content hash for change detection
  - Detect new entries by GUID
  - Store new entries in database
  - Handle entry updates (content hash changed)
  - Write integration tests

### 4.5 Background Worker

- [x] **Implement background job processing**
  - Create worker that polls for due jobs
  - Process fetch_feed jobs
  - Handle concurrent job execution
  - Implement graceful shutdown
  - Schedule next fetch after completion
  - Create initial fetch job on subscription

## Phase 5: Entry Display

### 5.1 Entry Queries API

- [x] **Implement entry listing endpoints**
  - GET /v1/entries - list entries with filters
  - Filter by feedId, unreadOnly, starredOnly
  - Implement cursor-based pagination
  - Enforce visibility (entries fetched after subscription)
  - GET /v1/entries/:id - get single entry with content

### 5.2 Entry Actions API

- [x] **Implement entry action endpoints**
  - POST /v1/entries/mark-read - mark entries read/unread (bulk)
  - POST /v1/entries/mark-all-read - mark all read with filters
  - POST /v1/entries/:id/star - star entry
  - DELETE /v1/entries/:id/star - unstar entry

### 5.3 Entry List UI

- [x] **Create entry list component**
  - Build entry list with items showing title, feed, date, preview
  - Show read/unread indicator (filled/empty circle)
  - Show starred indicator
  - Implement infinite scroll with cursor pagination
  - Add loading skeleton

### 5.4 Entry Content UI

- [x] **Create entry content view**
  - Build full entry view (title, author, date, content)
  - Mark entry as read when viewed
  - Add star/unstar button
  - Add link to original article
  - Handle HTML content safely (sanitization)

### 5.5 App Layout

- [x] **Create main app layout**
  - Build app shell with sidebar and main content area
  - Create header with subscribe button and user menu
  - Implement /all route (all entries)
  - Implement /starred route (starred entries)
  - Implement /feed/:feedId route (single feed)
  - Add responsive sidebar (collapsible on mobile)

## Phase 6: Real-time Updates

### 6.1 Redis Pub/Sub

- [x] **Implement event publishing**
  - Publish new_entry event when entry is stored
  - Publish entry_updated event when entry changes
  - Include feedId and entryId in events

### 6.2 SSE Endpoint

- [x] **Implement Server-Sent Events endpoint**
  - GET /v1/events - SSE stream for authenticated user
  - Subscribe to Redis channels for user's feeds
  - Forward events to client
  - Implement heartbeat (every 30 seconds)
  - Handle connection cleanup on disconnect

### 6.3 Client Real-time Integration

- [x] **Integrate real-time updates in UI**
  - Create useRealtimeUpdates hook with EventSource
  - Invalidate React Query cache on new_entry
  - Update unread counts in sidebar
  - Add connection status indicator (optional)
  - Handle reconnection gracefully

## Phase 7: Polish

### 7.1 Loading and Error States

- [x] **Implement loading and error states**
  - Add loading skeletons for entry list
  - Add loading skeletons for sidebar
  - Create error boundary with retry button
  - Add empty states (no entries, no subscriptions)
  - Handle offline state

### 7.2 Settings Pages

- [ ] **Create settings pages**
  - Build /settings route with account info
  - Build /settings/sessions route with session list
  - Add logout from specific sessions
  - Add change password form

### 7.3 Rate Limiting

- [ ] **Implement API rate limiting**
  - Set up Redis token bucket rate limiting
  - Apply rate limits to API routes (100 burst, 10/sec refill)
  - Apply stricter limits to expensive operations
  - Add rate limit headers to responses (X-RateLimit-\*)
  - Return 429 with Retry-After header when exceeded

### 7.4 Responsive Design

- [ ] **Polish responsive design**
  - Ensure mobile-friendly layout (< 768px)
  - Collapsible sidebar on mobile
  - Touch-friendly tap targets
  - Test on various screen sizes

## Phase 8: Deployment

### 8.1 CI Pipeline

- [ ] **Set up GitHub Actions CI**
  - Create workflow for PRs
  - Run typecheck, lint, unit tests
  - Run integration tests with Postgres/Redis services
  - Cache pnpm dependencies

### 8.2 Deployment Configuration

- [ ] **Configure Fly.io deployment**
  - Create fly.toml with app configuration
  - Create production Dockerfile
  - Set up release_command for migrations
  - Document environment variables needed
  - Create deployment workflow (on push to main)

### 8.3 Infrastructure Provisioning

- [ ] **Provision production infrastructure**
  - Create Fly.io Postgres database
  - Create Fly.io Redis (Upstash)
  - Configure environment variables/secrets
  - Verify deployment works end-to-end

### 8.4 Observability

- [ ] **Set up monitoring and error tracking**
  - Integrate Sentry for error tracking
  - Add structured logging
  - Set up basic health check endpoint
  - Document runbook for common issues

---

## Success Criteria

MVP is complete when:

1. [ ] User can create an account with email/password
2. [ ] User can subscribe to an RSS or Atom feed
3. [ ] User can see entries from their subscribed feeds
4. [ ] User can mark entries as read (individually and bulk)
5. [ ] User can star entries for later
6. [ ] User sees new entries appear in real-time (without refresh)
7. [ ] User can access their account from the public REST API
8. [ ] User can access the app from mobile web
