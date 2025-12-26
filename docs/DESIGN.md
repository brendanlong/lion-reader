# Lion Reader Design Document

## Table of Contents

1. [System Architecture](#system-architecture)
2. [Database Design](#database-design)
3. [Authentication](#authentication)
4. [Feed Processing](#feed-processing)
5. [Real-time Updates](#real-time-updates)
6. [API Design](#api-design)
7. [Frontend Architecture](#frontend-architecture)
8. [Infrastructure](#infrastructure)
9. [Observability](#observability)
10. [Testing Strategy](#testing-strategy)
11. [Future Work](#future-work)

---

## System Architecture

### High-Level Overview

```
                                    ┌──────────────────┐
                                    │  Email Service   │
                                    │  (Postmark/SES)  │
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
│  │ threads │  │     │               │     │               │
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
```

### Design Principles

1. **Stateless app servers**: All state in Postgres/Redis, enabling horizontal scaling
2. **Efficient data sharing**: Feed/entry data deduplicated across users
3. **Privacy by default**: Users only see entries fetched after they subscribed
4. **Graceful degradation**: Handle misbehaving feeds, rate limits, and failures
5. **Observable**: Comprehensive logging, metrics, and error tracking

### Component Responsibilities

| Component | Responsibilities |
|-----------|-----------------|
| **App Server** | HTTP API, SSE connections, background job execution |
| **Postgres** | Persistent storage, job queue (pg-boss style) |
| **Redis** | Session cache, rate limiting, pub/sub for real-time |
| **Email Service** | Inbound email processing for newsletter subscriptions |

---

## Database Design

### ID Strategy

All primary keys use **UUIDv7**, which provides:
- Global uniqueness without coordination
- Time-ordered (roughly chronological, good for pagination)
- Better B-tree index performance than UUIDv4 (sequential inserts)
- Extractable timestamp if needed

### Schema

```sql
-- ============================================================================
-- AUTHENTICATION
-- ============================================================================

CREATE TABLE users (
  id uuid PRIMARY KEY,  -- UUIDv7
  email text UNIQUE NOT NULL,
  email_verified_at timestamptz,
  password_hash text,  -- null if OAuth-only

  -- For email feed ingestion
  ingest_email_token text UNIQUE NOT NULL,  -- random token for ingest address

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Computed: ingest email is {ingest_email_token}@ingest.lionreader.com

CREATE TABLE oauth_accounts (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users ON DELETE CASCADE,
  provider text NOT NULL,  -- 'google', 'facebook', 'apple'
  provider_account_id text NOT NULL,

  -- Token storage for potential API access
  access_token text,
  refresh_token text,
  expires_at timestamptz,

  created_at timestamptz NOT NULL DEFAULT now(),

  UNIQUE(provider, provider_account_id)
);

CREATE INDEX idx_oauth_accounts_user ON oauth_accounts(user_id);

CREATE TABLE sessions (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users ON DELETE CASCADE,
  token_hash text UNIQUE NOT NULL,  -- SHA-256 of session token

  user_agent text,
  ip_address inet,

  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  last_active_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_sessions_user ON sessions(user_id);
CREATE INDEX idx_sessions_token ON sessions(token_hash) WHERE revoked_at IS NULL;

-- ============================================================================
-- FEEDS (shared canonical data)
-- ============================================================================

CREATE TYPE feed_type AS ENUM ('rss', 'atom', 'json', 'email');

CREATE TABLE feeds (
  id uuid PRIMARY KEY,
  type feed_type NOT NULL,

  -- For URL-based feeds (rss, atom, json)
  url text UNIQUE,
  canonical_url text,  -- after following permanent redirects

  -- For email feeds
  email_sender_pattern text,  -- domain or full address to match

  -- Metadata from feed
  title text,
  description text,
  site_url text,
  icon_url text,
  language text,

  -- Fetch state
  etag text,
  last_modified_header text,
  last_fetched_at timestamptz,
  last_successful_fetch_at timestamptz,
  next_fetch_at timestamptz,

  -- Error tracking
  consecutive_failures int NOT NULL DEFAULT 0,
  last_error text,
  last_error_at timestamptz,

  -- Caching behavior
  cache_max_age_seconds int,  -- from Cache-Control
  average_update_interval_seconds int,  -- computed from history
  polling_interval_override_seconds int,  -- manual override

  -- Redirect tracking
  redirect_url text,
  redirect_type text,  -- 'permanent', 'temporary'
  redirect_confirmed_count int NOT NULL DEFAULT 0,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT url_or_email CHECK (
    (type IN ('rss', 'atom', 'json') AND url IS NOT NULL) OR
    (type = 'email' AND email_sender_pattern IS NOT NULL)
  )
);

CREATE INDEX idx_feeds_next_fetch ON feeds(next_fetch_at)
  WHERE next_fetch_at IS NOT NULL AND consecutive_failures < 10;
CREATE INDEX idx_feeds_canonical_url ON feeds(canonical_url) WHERE canonical_url IS NOT NULL;

-- ============================================================================
-- ENTRIES (shared canonical data)
-- ============================================================================

CREATE TABLE entries (
  id uuid PRIMARY KEY,  -- UUIDv7, gives us time ordering
  feed_id uuid NOT NULL REFERENCES feeds ON DELETE CASCADE,

  -- Identifier from source
  guid text NOT NULL,  -- from RSS/Atom, or Message-ID for email

  -- Content
  url text,
  title text,
  author text,
  content_original text,
  content_cleaned text,  -- after readability extraction (future)
  summary text,  -- truncated for previews

  -- For email entries
  email_from text,
  email_subject text,

  -- Timestamps
  published_at timestamptz,  -- from feed (may be null or inaccurate)
  fetched_at timestamptz NOT NULL,  -- when we first saw it

  -- Version tracking
  content_hash text NOT NULL,  -- for detecting updates
  version int NOT NULL DEFAULT 1,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  UNIQUE(feed_id, guid)
);

-- For listing entries by feed, ordered by time (UUIDv7 is time-ordered)
CREATE INDEX idx_entries_feed ON entries(feed_id, id DESC);

-- For finding entries by fetched time (visibility filtering)
CREATE INDEX idx_entries_fetched ON entries(feed_id, fetched_at);

-- ============================================================================
-- ENTRY VERSIONS (for tracking changes)
-- ============================================================================

CREATE TABLE entry_versions (
  id uuid PRIMARY KEY,
  entry_id uuid NOT NULL REFERENCES entries ON DELETE CASCADE,
  version int NOT NULL,

  title text,
  content_original text,
  content_cleaned text,
  content_hash text NOT NULL,

  detected_at timestamptz NOT NULL DEFAULT now(),

  UNIQUE(entry_id, version)
);

CREATE INDEX idx_entry_versions_entry ON entry_versions(entry_id, version DESC);

-- ============================================================================
-- USER SUBSCRIPTIONS
-- ============================================================================

CREATE TABLE subscriptions (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users ON DELETE CASCADE,
  feed_id uuid NOT NULL REFERENCES feeds ON DELETE CASCADE,

  custom_title text,  -- user's override for feed title
  folder text,  -- optional organization

  subscribed_at timestamptz NOT NULL DEFAULT now(),  -- critical for visibility
  unsubscribed_at timestamptz,  -- soft delete

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  UNIQUE(user_id, feed_id)
);

CREATE INDEX idx_subscriptions_user ON subscriptions(user_id)
  WHERE unsubscribed_at IS NULL;
CREATE INDEX idx_subscriptions_feed ON subscriptions(feed_id)
  WHERE unsubscribed_at IS NULL;

-- ============================================================================
-- USER ENTRY STATE
-- ============================================================================

CREATE TABLE user_entry_states (
  user_id uuid NOT NULL REFERENCES users ON DELETE CASCADE,
  entry_id uuid NOT NULL REFERENCES entries ON DELETE CASCADE,

  read boolean NOT NULL DEFAULT false,
  starred boolean NOT NULL DEFAULT false,

  read_at timestamptz,
  starred_at timestamptz,

  PRIMARY KEY (user_id, entry_id)
);

-- For finding unread entries quickly
CREATE INDEX idx_user_entry_states_unread ON user_entry_states(user_id, entry_id)
  WHERE NOT read;

-- For starred entries view
CREATE INDEX idx_user_entry_states_starred ON user_entry_states(user_id, starred_at DESC)
  WHERE starred;

-- ============================================================================
-- WEBSUB SUBSCRIPTIONS
-- ============================================================================

CREATE TYPE websub_status AS ENUM ('pending', 'active', 'expired', 'failed');

CREATE TABLE websub_subscriptions (
  id uuid PRIMARY KEY,
  feed_id uuid NOT NULL REFERENCES feeds ON DELETE CASCADE,

  hub_url text NOT NULL,
  topic_url text NOT NULL,

  callback_secret text NOT NULL,  -- for HMAC verification

  lease_seconds int,
  subscribed_at timestamptz,
  expires_at timestamptz,

  status websub_status NOT NULL DEFAULT 'pending',
  last_error text,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  UNIQUE(feed_id, hub_url)
);

CREATE INDEX idx_websub_expiring ON websub_subscriptions(expires_at)
  WHERE status = 'active';

-- ============================================================================
-- JOB QUEUE
-- ============================================================================

CREATE TYPE job_status AS ENUM ('pending', 'running', 'completed', 'failed');

CREATE TABLE jobs (
  id uuid PRIMARY KEY,
  type text NOT NULL,  -- 'fetch_feed', 'process_email', 'renew_websub', 'cleanup'
  payload jsonb NOT NULL DEFAULT '{}',

  -- Scheduling
  scheduled_for timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz,

  -- Status and retries
  status job_status NOT NULL DEFAULT 'pending',
  attempts int NOT NULL DEFAULT 0,
  max_attempts int NOT NULL DEFAULT 3,
  last_error text,

  -- Locking (for distributed workers)
  locked_by text,
  locked_at timestamptz,

  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_jobs_pending ON jobs(scheduled_for)
  WHERE status = 'pending';
CREATE INDEX idx_jobs_running ON jobs(locked_at)
  WHERE status = 'running';

-- ============================================================================
-- HELPER FUNCTIONS
-- ============================================================================

-- Generate UUIDv7
CREATE OR REPLACE FUNCTION gen_uuidv7() RETURNS uuid AS $$
DECLARE
  unix_ts_ms bigint;
  buffer bytea;
BEGIN
  unix_ts_ms := (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint;
  buffer := set_byte(
    set_byte(
      set_byte(
        set_byte(
          set_byte(
            set_byte(
              gen_random_bytes(16),
              0, (unix_ts_ms >> 40)::int
            ),
            1, (unix_ts_ms >> 32)::int
          ),
          2, (unix_ts_ms >> 24)::int
        ),
        3, (unix_ts_ms >> 16)::int
      ),
      4, (unix_ts_ms >> 8)::int
    ),
    5, unix_ts_ms::int
  );
  -- Set version (7) and variant bits
  buffer := set_byte(buffer, 6, (get_byte(buffer, 6) & 15) | 112);  -- version 7
  buffer := set_byte(buffer, 8, (get_byte(buffer, 8) & 63) | 128);  -- variant
  RETURN encode(buffer, 'hex')::uuid;
END;
$$ LANGUAGE plpgsql VOLATILE;
```

### Key Design Decisions

**Entry Visibility**: Users only see entries where `entry.fetched_at >= subscription.subscribed_at`. This prevents information leakage when users subscribe to feeds that may have been private before.

**Soft Deletes**: Subscriptions use `unsubscribed_at` for soft delete, allowing users to resubscribe and maintain their read state.

**Version Tracking**: When entry content changes, we increment `version`, update the main entry, and store the previous version in `entry_versions`. This lets users see what changed.

**UUIDv7 Ordering**: Since UUIDv7 is time-ordered, `ORDER BY id DESC` gives us reverse chronological order without needing a separate timestamp column for sorting.

---

## Authentication

### Strategy

Roll our own auth using battle-tested primitives:
- **`arctic`**: Lightweight OAuth library for Google/Facebook/Apple
- **`argon2`**: Password hashing
- **Custom session management**: Token-based, stored in Postgres with Redis cache

### Session Flow

```
┌─────────┐     ┌─────────────┐     ┌─────────────┐
│ Client  │────▶│  App Server │────▶│   Redis     │
│         │     │             │     │  (cache)    │
└─────────┘     └──────┬──────┘     └─────────────┘
                       │                   │
                       │ cache miss        │
                       ▼                   │
                ┌─────────────┐            │
                │  Postgres   │◀───────────┘
                │  (source)   │   cache fill
                └─────────────┘
```

1. Client sends session token in cookie or Authorization header
2. Server hashes token, checks Redis cache
3. Cache miss: query Postgres, fill cache (TTL: 5 minutes)
4. Validate: not revoked, not expired
5. Update `last_active_at` asynchronously

### Password Auth

```typescript
// Registration
const passwordHash = await argon2.hash(password);
await db.users.create({ email, passwordHash });

// Login
const user = await db.users.findByEmail(email);
if (!user?.passwordHash) throw new Error('Invalid credentials');
if (!await argon2.verify(user.passwordHash, password)) {
  throw new Error('Invalid credentials');
}
const session = await createSession(user.id);
```

### OAuth Flow

```typescript
// Using arctic for OAuth
import { Google, Facebook, Apple } from 'arctic';

const google = new Google(clientId, clientSecret, redirectUri);

// Step 1: Redirect to provider
const authUrl = google.createAuthorizationURL(state, codeVerifier, scopes);

// Step 2: Handle callback
const tokens = await google.validateAuthorizationCode(code, codeVerifier);
const userInfo = await fetchGoogleUserInfo(tokens.accessToken);

// Step 3: Find or create user
let user = await db.users.findByOAuth('google', userInfo.sub);
if (!user) {
  user = await db.users.create({ email: userInfo.email });
  await db.oauthAccounts.create({
    userId: user.id,
    provider: 'google',
    providerAccountId: userInfo.sub,
  });
}

const session = await createSession(user.id);
```

### Token Format

Session tokens are 32 random bytes, base64url encoded. We store SHA-256 hash in database (never the raw token).

```typescript
const token = crypto.randomBytes(32).toString('base64url');
const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
```

---

## Feed Processing

### Polling Strategy

```
┌─────────────────────────────────────────────────────────────────┐
│                     Feed Fetch Decision                         │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  1. Check next_fetch_at - is it time?                          │
│     └─ No: skip                                                 │
│     └─ Yes: continue                                            │
│                                                                 │
│  2. Check consecutive_failures                                  │
│     └─ >= 10: exponential backoff (max 7 days)                 │
│     └─ < 10: continue                                           │
│                                                                 │
│  3. Make HTTP request with:                                     │
│     └─ If-None-Match: {etag}                                   │
│     └─ If-Modified-Since: {last_modified_header}               │
│                                                                 │
│  4. Handle response:                                            │
│     └─ 304 Not Modified: update next_fetch_at, done            │
│     └─ 200 OK: parse feed, process entries                     │
│     └─ 301 Permanent Redirect: track, maybe update URL         │
│     └─ 302/307 Temporary Redirect: follow, don't update URL    │
│     └─ 429 Too Many Requests: respect Retry-After              │
│     └─ 4xx/5xx: increment failures, backoff                    │
│                                                                 │
│  5. Calculate next_fetch_at:                                    │
│     └─ Cache-Control max-age (if reasonable: 1min - 7days)     │
│     └─ Otherwise: adaptive based on update frequency           │
│     └─ Default: 15 minutes                                      │
│     └─ Minimum: 1 minute (never poll faster)                   │
│     └─ Maximum: 7 days (always check eventually)               │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### Redirect Handling

Permanent redirects (301) are tricky - we don't want to immediately trust them:

```typescript
if (response.status === 301) {
  const newUrl = response.headers.get('location');

  if (feed.redirectUrl === newUrl) {
    // Same redirect seen again
    feed.redirectConfirmedCount++;

    if (feed.redirectConfirmedCount >= 3) {
      // Seen 3+ times, update canonical URL
      feed.canonicalUrl = newUrl;
      feed.url = newUrl;  // or keep original as alias
    }
  } else {
    // New redirect destination
    feed.redirectUrl = newUrl;
    feed.redirectType = 'permanent';
    feed.redirectConfirmedCount = 1;
  }
}
```

### Entry Processing

```typescript
async function processEntries(feed: Feed, parsedFeed: ParsedFeed) {
  for (const item of parsedFeed.items) {
    const guid = item.guid || item.link || item.title;  // fallback chain
    const contentHash = hash(item.content + item.title);

    const existing = await db.entries.findByGuid(feed.id, guid);

    if (!existing) {
      // New entry
      await db.entries.create({
        feedId: feed.id,
        guid,
        url: item.link,
        title: item.title,
        author: item.author,
        contentOriginal: item.content,
        contentCleaned: item.content,  // TODO: readability extraction
        summary: truncate(stripHtml(item.content), 300),
        publishedAt: item.pubDate,
        fetchedAt: new Date(),
        contentHash,
      });

      // Notify subscribers via Redis pub/sub
      await redis.publish(`feed:${feed.id}:new_entry`, JSON.stringify({ guid }));

    } else if (existing.contentHash !== contentHash) {
      // Entry updated
      await db.entryVersions.create({
        entryId: existing.id,
        version: existing.version,
        title: existing.title,
        contentOriginal: existing.contentOriginal,
        contentCleaned: existing.contentCleaned,
        contentHash: existing.contentHash,
      });

      await db.entries.update(existing.id, {
        title: item.title,
        contentOriginal: item.content,
        contentCleaned: item.content,
        contentHash,
        version: existing.version + 1,
      });

      await redis.publish(`feed:${feed.id}:entry_updated`, JSON.stringify({
        entryId: existing.id
      }));
    }
    // else: no change, skip
  }
}
```

### Feed Parsing

Support multiple formats with a unified output:

```typescript
interface ParsedFeed {
  title: string;
  description?: string;
  siteUrl?: string;
  iconUrl?: string;
  items: ParsedEntry[];

  // WebSub discovery
  hubUrl?: string;
  selfUrl?: string;
}

interface ParsedEntry {
  guid?: string;
  link?: string;
  title?: string;
  author?: string;
  content?: string;
  summary?: string;
  pubDate?: Date;
}

function parseFeed(content: string, contentType: string): ParsedFeed {
  if (contentType.includes('json')) {
    return parseJsonFeed(content);
  }

  // XML-based (RSS, Atom)
  const doc = parseXml(content);

  if (doc.querySelector('feed')) {
    return parseAtomFeed(doc);
  } else if (doc.querySelector('rss') || doc.querySelector('channel')) {
    return parseRssFeed(doc);
  }

  throw new Error('Unknown feed format');
}
```

### Rate Limiting Outbound Requests

Per-domain rate limiting to be a good citizen:

```typescript
const DOMAIN_RATE_LIMITS = {
  default: { requests: 1, windowMs: 1000 },  // 1 req/sec default
  // Could add per-domain overrides
};

async function fetchWithRateLimit(url: string): Promise<Response> {
  const domain = new URL(url).hostname;
  const key = `ratelimit:fetch:${domain}`;

  // Simple sliding window in Redis
  const count = await redis.incr(key);
  if (count === 1) {
    await redis.pexpire(key, 1000);  // 1 second window
  }

  if (count > DOMAIN_RATE_LIMITS.default.requests) {
    // Wait for window to expire
    const ttl = await redis.pttl(key);
    await sleep(ttl);
  }

  return fetch(url, {
    headers: {
      'User-Agent': 'LionReader/1.0 (+https://lionreader.com/bot)',
    },
  });
}
```

---

## Real-time Updates

### Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        Real-time Flow                           │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  1. Feed worker fetches feed, finds new entry                  │
│                                                                 │
│  2. Worker publishes to Redis:                                 │
│     PUBLISH feed:{feedId}:new_entry {entryId, ...}             │
│                                                                 │
│  3. All app servers are subscribed to Redis channels           │
│                                                                 │
│  4. App server receives message, looks up which connected      │
│     users are subscribed to that feed                          │
│                                                                 │
│  5. App server sends SSE event to those users                  │
│                                                                 │
│  6. Client receives event, invalidates React Query cache       │
│                                                                 │
│  7. UI updates automatically                                    │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### Server-Sent Events Endpoint

```typescript
// app/api/v1/events/route.ts
export async function GET(req: Request) {
  const session = await getSession(req);
  if (!session) {
    return new Response('Unauthorized', { status: 401 });
  }

  const subscriptions = await db.subscriptions.listForUser(session.userId);
  const feedIds = subscriptions.map(s => s.feedId);

  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();

      // Subscribe to Redis channels for user's feeds
      const subscriber = redis.duplicate();

      for (const feedId of feedIds) {
        subscriber.subscribe(`feed:${feedId}:new_entry`);
        subscriber.subscribe(`feed:${feedId}:entry_updated`);
      }

      subscriber.on('message', (channel, message) => {
        const [, feedId, eventType] = channel.split(':');
        const data = JSON.stringify({ feedId, ...JSON.parse(message) });
        controller.enqueue(encoder.encode(`event: ${eventType}\ndata: ${data}\n\n`));
      });

      // Heartbeat every 30 seconds
      const heartbeat = setInterval(() => {
        controller.enqueue(encoder.encode(': heartbeat\n\n'));
      }, 30000);

      // Cleanup on close
      req.signal.addEventListener('abort', () => {
        clearInterval(heartbeat);
        subscriber.quit();
      });
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  });
}
```

### Client-Side Handling

```typescript
// hooks/useRealtimeUpdates.ts
export function useRealtimeUpdates() {
  const queryClient = useQueryClient();

  useEffect(() => {
    const eventSource = new EventSource('/api/v1/events', {
      withCredentials: true,
    });

    eventSource.addEventListener('new_entry', (e) => {
      const { feedId } = JSON.parse(e.data);
      queryClient.invalidateQueries({ queryKey: ['entries', { feedId }] });
      queryClient.invalidateQueries({ queryKey: ['entries', 'all'] });
      queryClient.invalidateQueries({ queryKey: ['subscriptions'] });  // unread counts
    });

    eventSource.addEventListener('entry_updated', (e) => {
      const { entryId } = JSON.parse(e.data);
      queryClient.invalidateQueries({ queryKey: ['entries', entryId] });
    });

    eventSource.onerror = () => {
      // Reconnect handled automatically by EventSource
      // But we might want to show a "reconnecting" indicator
    };

    return () => eventSource.close();
  }, [queryClient]);
}
```

---

## API Design

### tRPC Router Structure

```typescript
// server/trpc/root.ts
import { router } from './trpc';
import { authRouter } from './routers/auth';
import { usersRouter } from './routers/users';
import { subscriptionsRouter } from './routers/subscriptions';
import { entriesRouter } from './routers/entries';
import { feedsRouter } from './routers/feeds';

export const appRouter = router({
  auth: authRouter,
  users: usersRouter,
  subscriptions: subscriptionsRouter,
  entries: entriesRouter,
  feeds: feedsRouter,
});

export type AppRouter = typeof appRouter;
```

### Endpoints

#### Auth Router

```typescript
auth.register        POST   /v1/auth/register
auth.login           POST   /v1/auth/login
auth.logout          POST   /v1/auth/logout
auth.oauthUrl        GET    /v1/auth/oauth/:provider
auth.oauthCallback   POST   /v1/auth/oauth/:provider/callback
auth.forgotPassword  POST   /v1/auth/forgot-password
auth.resetPassword   POST   /v1/auth/reset-password
```

#### Users Router

```typescript
users.me             GET    /v1/users/me
users.update         PATCH  /v1/users/me
users.sessions       GET    /v1/users/me/sessions
users.revokeSession  DELETE /v1/users/me/sessions/:id
users.ingestEmail    GET    /v1/users/me/ingest-email  // get ingest address
```

#### Subscriptions Router

```typescript
subscriptions.list      GET    /v1/subscriptions
subscriptions.get       GET    /v1/subscriptions/:id
subscriptions.create    POST   /v1/subscriptions
subscriptions.update    PATCH  /v1/subscriptions/:id
subscriptions.delete    DELETE /v1/subscriptions/:id
```

#### Entries Router

```typescript
entries.list         GET    /v1/entries
entries.get          GET    /v1/entries/:id
entries.versions     GET    /v1/entries/:id/versions
entries.markRead     POST   /v1/entries/mark-read
entries.markAllRead  POST   /v1/entries/mark-all-read
entries.star         POST   /v1/entries/:id/star
entries.unstar       DELETE /v1/entries/:id/star
entries.search       GET    /v1/entries/search
```

#### Feeds Router

```typescript
feeds.preview        GET    /v1/feeds/preview?url=...  // preview before subscribing
feeds.discover       GET    /v1/feeds/discover?url=... // find feeds on a page
```

### Pagination

Cursor-based pagination everywhere:

```typescript
// Request
{
  cursor?: string;  // opaque cursor from previous response
  limit?: number;   // default 50, max 100
}

// Response
{
  items: T[];
  nextCursor?: string;  // undefined if no more items
}
```

Cursor is base64-encoded `{id}` (UUIDv7 gives us ordering).

### Rate Limiting

Token bucket via Redis, per-user:

```typescript
const RATE_LIMITS = {
  default: { capacity: 100, refillRate: 10 },  // 100 burst, 10/sec refill
  search: { capacity: 10, refillRate: 1 },     // search is expensive
};

async function checkRateLimit(userId: string, bucket = 'default'): Promise<boolean> {
  const config = RATE_LIMITS[bucket];
  const key = `ratelimit:api:${userId}:${bucket}`;

  // Token bucket implementation in Redis
  const tokens = await redis.tokenBucket(key, config.capacity, config.refillRate);
  return tokens > 0;
}
```

### Error Responses

Consistent error format:

```typescript
{
  error: {
    code: string;       // machine-readable: 'UNAUTHORIZED', 'NOT_FOUND', etc.
    message: string;    // human-readable
    details?: object;   // additional context
  }
}
```

---

## Frontend Architecture

### Route Structure

```
app/
  layout.tsx                    # HTML shell, global providers
  page.tsx                      # Landing page (unauthenticated)

  (auth)/
    layout.tsx                  # Centered auth layout
    login/page.tsx
    register/page.tsx
    forgot-password/page.tsx
    reset-password/page.tsx

  (app)/
    layout.tsx                  # App shell: sidebar + main
    page.tsx                    # Redirect to /all

    all/
      page.tsx                  # All entries, unified timeline
      loading.tsx               # Suspense fallback

    starred/page.tsx            # Starred entries

    folder/[name]/page.tsx      # Entries in folder

    feed/[feedId]/page.tsx      # Single feed entries

    entry/[entryId]/page.tsx    # Full entry view

    settings/
      layout.tsx
      page.tsx                  # General settings
      sessions/page.tsx         # Manage sessions

    subscribe/page.tsx          # Add subscription flow

api/
  v1/
    events/route.ts             # SSE endpoint
    trpc/[trpc]/route.ts        # tRPC handler

  webhooks/
    email/route.ts              # Inbound email webhook
    websub/route.ts             # WebSub callback
```

### Component Architecture

```
components/
  layout/
    Sidebar.tsx              # Navigation, feed list
    Header.tsx               # Title, actions

  entries/
    EntryList.tsx            # Virtualized entry list
    EntryListItem.tsx        # Single entry row
    EntryContent.tsx         # Full entry view
    EntryActions.tsx         # Read, star, share buttons

  feeds/
    FeedList.tsx             # Sidebar feed list
    FeedListItem.tsx         # Feed with unread count
    AddFeedDialog.tsx        # Subscribe flow

  ui/                        # Generic UI components
    Button.tsx
    Dialog.tsx
    Input.tsx
    ...
```

### Server vs Client Components

| Server Components (default) | Client Components ('use client') |
|-----------------------------|----------------------------------|
| Sidebar feed list (initial) | Keyboard navigation |
| Entry list (initial render) | Mark read/star interactions |
| Entry content | Optimistic updates |
| Settings forms | Real-time indicators |
| | Infinite scroll |
| | SSE subscription |

### State Management

```typescript
// TanStack Query for all server state
const { data: entries } = trpc.entries.list.useQuery({
  feedId,
  unreadOnly: true,
});

// Mutations with optimistic updates
const markRead = trpc.entries.markRead.useMutation({
  onMutate: async ({ ids, read }) => {
    // Cancel outgoing refetches
    await queryClient.cancelQueries({ queryKey: ['entries'] });

    // Optimistically update
    queryClient.setQueryData(['entries'], (old) =>
      old.map(e => ids.includes(e.id) ? { ...e, read } : e)
    );
  },
  onError: (err, variables, context) => {
    // Rollback on error
    queryClient.setQueryData(['entries'], context.previousEntries);
  },
});
```

---

## Infrastructure

### Fly.io Configuration

```toml
# fly.toml
app = "lionreader"
primary_region = "iad"  # US East

[build]
  dockerfile = "Dockerfile"

[deploy]
  release_command = "pnpm db:migrate"

[env]
  NODE_ENV = "production"
  PORT = "3000"

[http_service]
  internal_port = 3000
  force_https = true
  auto_start_machines = true
  auto_stop_machines = true
  min_machines_running = 1

  [http_service.concurrency]
    type = "connections"
    hard_limit = 1000
    soft_limit = 800

[[vm]]
  cpu_kind = "shared"
  cpus = 1
  memory_mb = 512

# Scaling
[[services]]
  internal_port = 3000
  protocol = "tcp"

  [[services.ports]]
    handlers = ["tls", "http"]
    port = 443
```

### Docker Configuration

```dockerfile
# Dockerfile
FROM node:20-slim AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable

FROM base AS build
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile
COPY . .
RUN pnpm build

FROM base AS runtime
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/.next ./.next
COPY --from=build /app/public ./public
COPY --from=build /app/drizzle ./drizzle

EXPOSE 3000
CMD ["pnpm", "start"]
```

### CI/CD Pipeline

```yaml
# .github/workflows/ci.yml
name: CI

on:
  pull_request:
    branches: [main]

jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v2
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'pnpm'

      - run: pnpm install --frozen-lockfile
      - run: pnpm typecheck
      - run: pnpm lint
      - run: pnpm test:unit

  integration:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:16
        env:
          POSTGRES_DB: test
          POSTGRES_PASSWORD: test
        options: >-
          --health-cmd pg_isready
          --health-interval 10s
        ports:
          - 5432:5432
      redis:
        image: redis:7
        ports:
          - 6379:6379

    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v2
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'pnpm'

      - run: pnpm install --frozen-lockfile
      - run: pnpm db:migrate
        env:
          DATABASE_URL: postgresql://postgres:test@localhost:5432/test
      - run: pnpm test:integration
        env:
          DATABASE_URL: postgresql://postgres:test@localhost:5432/test
          REDIS_URL: redis://localhost:6379
```

```yaml
# .github/workflows/deploy.yml
name: Deploy

on:
  push:
    branches: [main]

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: superfly/flyctl-actions/setup-flyctl@master
      - run: flyctl deploy --remote-only
        env:
          FLY_API_TOKEN: ${{ secrets.FLY_API_TOKEN }}
```

### Local Development

```yaml
# docker-compose.yml
services:
  postgres:
    image: postgres:16
    environment:
      POSTGRES_DB: lionreader
      POSTGRES_PASSWORD: postgres
    ports:
      - "5432:5432"
    volumes:
      - postgres_data:/var/lib/postgresql/data

  redis:
    image: redis:7
    ports:
      - "6379:6379"
    volumes:
      - redis_data:/data

volumes:
  postgres_data:
  redis_data:
```

---

## Observability

### Stack

- **Metrics**: Grafana Cloud (Prometheus)
- **Logs**: Grafana Cloud (Loki)
- **Errors**: Sentry
- **Instrumentation**: OpenTelemetry

### Key Metrics

```typescript
// Feed fetching
feed_fetch_total{status="success|error|not_modified"}
feed_fetch_duration_seconds
feed_fetch_entries_count

// API
http_request_total{method, path, status}
http_request_duration_seconds{method, path}

// Background jobs
job_total{type, status="completed|failed"}
job_duration_seconds{type}
job_queue_depth{type}

// Real-time
sse_connections_active
sse_events_sent_total{type}

// Business metrics
active_users_daily
entries_fetched_total
subscriptions_created_total
```

### Structured Logging

```typescript
import { logger } from '@/lib/logger';

logger.info('Feed fetched', {
  feedId: feed.id,
  url: feed.url,
  entriesFound: entries.length,
  durationMs: duration,
});

logger.error('Feed fetch failed', {
  feedId: feed.id,
  url: feed.url,
  error: error.message,
  attempt: job.attempts,
});
```

### Error Tracking

```typescript
import * as Sentry from '@sentry/nextjs';

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  environment: process.env.NODE_ENV,
  tracesSampleRate: 0.1,  // 10% of transactions
});

// In error handlers
Sentry.captureException(error, {
  extra: { feedId, userId },
});
```

---

## Testing Strategy

### Philosophy

Structure code so business logic is pure and can be unit tested without mocks. Integration tests use real databases.

### Test Structure

```
tests/
  unit/
    feed-parser.test.ts       # Pure parsing logic
    cache-headers.test.ts     # Cache-Control interpretation
    next-fetch.test.ts        # Next fetch time calculation
    entry-diff.test.ts        # Change detection
    rate-limit.test.ts        # Rate limit decisions

  integration/
    auth.test.ts              # Full auth flows
    subscriptions.test.ts     # CRUD operations
    entries.test.ts           # Entry queries
    feed-fetch.test.ts        # Full fetch cycle
    websub.test.ts            # WebSub flow

  e2e/                        # Optional, Playwright
    subscribe.test.ts
    read-entries.test.ts
```

### Unit Test Example

```typescript
// tests/unit/next-fetch.test.ts
import { describe, it, expect } from 'vitest';
import { calculateNextFetch } from '@/lib/feed/scheduling';

describe('calculateNextFetch', () => {
  it('respects Cache-Control max-age within bounds', () => {
    const result = calculateNextFetch({
      cacheControl: { maxAge: 3600 },  // 1 hour
      lastFetch: new Date('2024-01-01T12:00:00Z'),
    });

    expect(result).toEqual(new Date('2024-01-01T13:00:00Z'));
  });

  it('caps max-age at 7 days', () => {
    const result = calculateNextFetch({
      cacheControl: { maxAge: 86400 * 30 },  // 30 days
      lastFetch: new Date('2024-01-01T12:00:00Z'),
    });

    // Should cap at 7 days
    expect(result).toEqual(new Date('2024-01-08T12:00:00Z'));
  });

  it('enforces minimum of 1 minute', () => {
    const result = calculateNextFetch({
      cacheControl: { maxAge: 10 },  // 10 seconds
      lastFetch: new Date('2024-01-01T12:00:00Z'),
    });

    expect(result).toEqual(new Date('2024-01-01T12:01:00Z'));
  });
});
```

### Integration Test Example

```typescript
// tests/integration/subscriptions.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { createTestContext } from '../helpers';

describe('Subscriptions', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await createTestContext();  // Fresh DB, authenticated user
  });

  it('creates subscription and returns feed metadata', async () => {
    const result = await ctx.trpc.subscriptions.create({
      url: 'https://example.com/feed.xml',
    });

    expect(result.feed.title).toBe('Example Feed');
    expect(result.subscription.subscribedAt).toBeDefined();
  });

  it('deduplicates feeds across users', async () => {
    // User 1 subscribes
    await ctx.trpc.subscriptions.create({ url: 'https://example.com/feed.xml' });

    // User 2 subscribes to same feed
    const ctx2 = await createTestContext();  // Different user
    await ctx2.trpc.subscriptions.create({ url: 'https://example.com/feed.xml' });

    // Should be same feed ID
    const feeds = await ctx.db.feeds.findAll();
    expect(feeds).toHaveLength(1);
  });

  it('only shows entries after subscription date', async () => {
    // Feed has entries from before user subscribed
    const feed = await ctx.db.feeds.create({ url: 'https://example.com/feed.xml' });
    await ctx.db.entries.create({
      feedId: feed.id,
      fetchedAt: new Date('2024-01-01'),  // Old entry
    });

    // User subscribes now
    await ctx.trpc.subscriptions.create({ url: feed.url });

    // Add new entry after subscription
    await ctx.db.entries.create({
      feedId: feed.id,
      fetchedAt: new Date(),  // New entry
    });

    // User should only see the new entry
    const entries = await ctx.trpc.entries.list({ feedId: feed.id });
    expect(entries.items).toHaveLength(1);
  });
});
```

---

## Future Work

Features and improvements for post-MVP development:

### Feed Features
- **OPML import/export**: Standard format for migrating from other readers
- **JSON Feed support**: In addition to RSS/Atom
- **Feed discovery**: Auto-detect feeds from arbitrary URLs
- **Feed recommendations**: Suggest popular feeds based on interests
- **Feed health dashboard**: Show fetch success rates, update frequency

### User Experience
- **Keyboard shortcuts**: vim-style navigation (j/k, o, m, s)
- **Offline support**: Service worker + IndexedDB cache
- **PWA**: Installable web app with push notifications
- **Themes**: Dark mode, custom colors
- **Folder/tag organization**: Hierarchical organization of feeds

### Content
- **Readability extraction**: Clean article extraction for feeds with summaries only
- **Full-text search**: Enhanced search with filters, saved searches
- **Highlights and notes**: Annotate entries
- **Read later queue**: Save entries for later reading

### Mobile
- **Native iOS app**: Swift/SwiftUI
- **Native Android app**: Kotlin/Compose
- **Responsive web**: Optimized mobile web experience

### Social
- **Public profiles**: Share what you're reading
- **Shared folders**: Collaborative feed collections
- **Comments**: Discuss entries with other users

### Infrastructure
- **Multi-region deployment**: Fly.io regions for global latency
- **Read replicas**: Postgres read replicas for scale
- **CDN**: Cache static assets and common API responses
- **Adaptive rate limiting**: System-load-aware rate limits

### Integrations
- **Pocket/Instapaper**: Send to read-later services
- **Browser extension**: Subscribe from any page
- **Zapier/IFTTT**: Automation triggers
- **Newsletter detection**: Auto-organize email subscriptions by sender
