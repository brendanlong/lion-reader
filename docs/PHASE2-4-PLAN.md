# Lion Reader: Phases 2-4 Implementation Plan

This document outlines the implementation plan for post-MVP features.

## Overview

| Phase       | Focus            | Key Features                                                  |
| ----------- | ---------------- | ------------------------------------------------------------- |
| **Phase 2** | User Acquisition | OAuth (Google, Apple), OPML import/export, Keyboard shortcuts |
| **Phase 3** | Organization     | Tags, JSON Feed support, Feed discovery                       |
| **Phase 4** | Scale & Quality  | WebSub push, Prometheus metrics, Content cleaning             |

---

## Phase 2: User Acquisition & Migration

### 2.1 OAuth Login (Google + Apple)

**Dependencies**: None (builds on existing auth)

**Schema Changes**:

```sql
-- Already in DESIGN.md, needs migration
CREATE TABLE oauth_accounts (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users ON DELETE CASCADE,
  provider text NOT NULL,  -- 'google', 'apple'
  provider_account_id text NOT NULL,

  access_token text,
  refresh_token text,
  expires_at timestamptz,

  created_at timestamptz NOT NULL DEFAULT now(),

  UNIQUE(provider, provider_account_id)
);

CREATE INDEX idx_oauth_accounts_user ON oauth_accounts(user_id);
```

**Implementation**:

1. **Google OAuth**
   - Use `arctic` library (already in design)
   - Scopes: `openid`, `email`, `profile`
   - Flow: Authorization code with PKCE

2. **Apple OAuth**
   - Use `arctic` for Apple provider
   - Requires Apple Developer account + Services ID
   - Handle private relay email (users can hide real email)
   - Apple only sends user info on first auth - must capture name/email then

**API Endpoints**:

```
GET  /v1/auth/oauth/:provider          → { url, state }
POST /v1/auth/oauth/:provider/callback → { user, session }
POST /v1/auth/link/:provider           → Link OAuth to existing account
DELETE /v1/auth/link/:provider         → Unlink OAuth from account
```

**UI Changes**:

- Add "Sign in with Google" / "Sign in with Apple" buttons to login page
- Add "Continue with..." buttons to register page
- Settings page: manage linked accounts

**Environment Variables**:

```
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
APPLE_CLIENT_ID=
APPLE_TEAM_ID=
APPLE_KEY_ID=
APPLE_PRIVATE_KEY=
```

---

### 2.2 OPML Import/Export

**Dependencies**: None

**Implementation**:

1. **OPML Parser** (pure function, unit testable)

   ```typescript
   interface OpmlFeed {
     title?: string;
     xmlUrl: string;
     htmlUrl?: string;
     category?: string[]; // nested folder path
   }

   function parseOpml(xml: string): OpmlFeed[];
   function generateOpml(subscriptions: Subscription[]): string;
   ```

2. **Import Flow**
   - User uploads .opml file
   - Parse and validate
   - Show preview: list of feeds to import with any errors
   - User confirms
   - Create subscriptions (batch, with progress)
   - Handle existing subscriptions gracefully (skip or update)

3. **Export Flow**
   - Generate OPML from user's subscriptions
   - Include tags as OPML categories
   - Download as .opml file

**API Endpoints**:

```
POST /v1/subscriptions/import      { opml: string } → { imported: number, skipped: number, errors: ImportError[] }
GET  /v1/subscriptions/export      → OPML XML file
```

**UI**:

- Settings page: Import/Export section
- Import: file upload with drag-and-drop
- Preview modal showing feeds to import
- Progress indicator for large imports

---

### 2.3 Keyboard Shortcuts

**Dependencies**: None

**Shortcuts**:
| Key | Action | Context |
|-----|--------|---------|
| `j` | Next entry | Entry list |
| `k` | Previous entry | Entry list |
| `o` / `Enter` | Open selected entry | Entry list |
| `Escape` | Close entry / deselect | Entry view |
| `m` | Toggle read/unread | Entry selected |
| `s` | Toggle star | Entry selected |
| `v` | Open original URL | Entry selected |
| `r` | Refresh current view | Any |
| `g` then `a` | Go to All | Any |
| `g` then `s` | Go to Starred | Any |
| `?` | Show keyboard shortcuts help | Any |

**Implementation**:

- Use `react-hotkeys-hook` library
- Create `useKeyboardShortcuts()` hook
- Track "selected" entry state (separate from "open")
- Visual indicator for selected entry
- Help modal showing all shortcuts

**UI**:

- Selected entry highlight style
- `?` opens shortcuts cheat sheet modal
- Settings: option to disable keyboard shortcuts

---

## Phase 3: Organization & Discovery

### 3.1 Tags

**Dependencies**: None

**Schema Changes** (replaces `folder` column approach):

```sql
CREATE TABLE tags (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users ON DELETE CASCADE,
  name text NOT NULL,
  color text,  -- hex color for UI
  created_at timestamptz NOT NULL DEFAULT now(),

  UNIQUE(user_id, name)
);

CREATE TABLE subscription_tags (
  subscription_id uuid NOT NULL REFERENCES subscriptions ON DELETE CASCADE,
  tag_id uuid NOT NULL REFERENCES tags ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (subscription_id, tag_id)
);

CREATE INDEX idx_subscription_tags_tag ON subscription_tags(tag_id);

-- Migration: Remove folder column from subscriptions if present
-- ALTER TABLE subscriptions DROP COLUMN IF EXISTS folder;
```

**API Endpoints**:

```
GET    /v1/tags                    → { items: Tag[] }
POST   /v1/tags                    { name, color? } → { tag }
PATCH  /v1/tags/:id                { name?, color? } → { tag }
DELETE /v1/tags/:id                → {}

POST   /v1/subscriptions/:id/tags  { tagIds: string[] } → {}  -- Set tags (replace)
```

**Entry Filtering**:

```
GET /v1/entries?tagId=xxx          → Entries from feeds with this tag
```

**UI**:

- Sidebar: tags section with colored dots
- Tag management in settings
- Subscription edit: tag picker (multi-select)
- Entry list: filter by tag

---

### 3.2 JSON Feed Support

**Dependencies**: None (extends feed parser)

**Implementation**:

- Add JSON Feed parser alongside RSS/Atom
- Detect by content-type (`application/feed+json`) or structure
- Map to existing `ParsedFeed` interface

**JSON Feed Spec** (https://jsonfeed.org/version/1.1):

```typescript
interface JsonFeed {
  version: string;
  title: string;
  home_page_url?: string;
  feed_url?: string;
  description?: string;
  icon?: string;
  items: JsonFeedItem[];
}

interface JsonFeedItem {
  id: string;
  url?: string;
  title?: string;
  content_html?: string;
  content_text?: string;
  summary?: string;
  date_published?: string;
  authors?: { name?: string }[];
}
```

**Schema Change**:

```sql
-- Update feed_type enum
ALTER TYPE feed_type ADD VALUE 'json';
```

---

### 3.3 Feed Discovery

**Dependencies**: None

**Implementation**:

1. Given any URL, find associated feeds
2. Check for `<link rel="alternate">` in HTML
3. Check common paths: `/feed`, `/rss`, `/atom.xml`, `/feed.xml`, `/index.xml`
4. Return list of discovered feeds with metadata

```typescript
interface DiscoveredFeed {
  url: string;
  title?: string;
  type: "rss" | "atom" | "json";
}

async function discoverFeeds(url: string): Promise<DiscoveredFeed[]>;
```

**API Endpoint**:

```
GET /v1/feeds/discover?url=https://example.com → { feeds: DiscoveredFeed[] }
```

**UI Enhancement**:

- Subscribe dialog: enter any URL
- If not a feed, show discovered feeds to choose from
- "We found X feeds on this site" UI

---

## Phase 4: Performance & Scale

### 4.1 WebSub Push

**Dependencies**: Feed parser must extract hub URL

**Schema** (from DESIGN.md):

```sql
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
```

**Implementation**:

1. **Hub Discovery**
   - Parse `<link rel="hub">` from feeds
   - Store hub_url on feed record

2. **Subscription Flow**
   - When feed has hub, attempt WebSub subscription
   - Generate unique callback URL with secret
   - POST subscription request to hub
   - Handle verification callback (hub GETs our callback)

3. **Callback Endpoint**

   ```
   GET  /api/webhooks/websub/:feedId  → Verification (return challenge)
   POST /api/webhooks/websub/:feedId  → Content notification
   ```

4. **Content Handling**
   - Verify HMAC signature
   - Parse pushed content
   - Process entries same as polling

5. **Renewal Job**
   - Background job to renew expiring subscriptions
   - Run daily, renew subscriptions expiring within 24 hours

6. **Fallback**
   - If WebSub fails, fall back to polling
   - Track WebSub status for monitoring

**Feed Changes**:

```sql
ALTER TABLE feeds ADD COLUMN hub_url text;
ALTER TABLE feeds ADD COLUMN websub_active boolean NOT NULL DEFAULT false;
```

---

### 4.2 Prometheus Metrics

**Dependencies**: None

**Library**: `prom-client`

**Metrics to Track**:

```typescript
// HTTP
http_requests_total{method, path, status}
http_request_duration_seconds{method, path}

// Feed Fetching
feed_fetch_total{status}  // success, not_modified, error
feed_fetch_duration_seconds
feed_entries_fetched_total

// Background Jobs
job_processed_total{type, status}
job_duration_seconds{type}
job_queue_size{type, status}

// WebSub (Phase 4.1)
websub_subscriptions_total{status}
websub_notifications_received_total

// Real-time
sse_connections_active
sse_events_sent_total{type}

// Business Metrics
users_total
subscriptions_total
entries_total
```

**Implementation**:

1. **Metrics Registry**

   ```typescript
   // src/server/metrics/index.ts
   import { Registry, Counter, Histogram, Gauge } from "prom-client";

   export const registry = new Registry();

   export const httpRequestsTotal = new Counter({
     name: "http_requests_total",
     help: "Total HTTP requests",
     labelNames: ["method", "path", "status"],
     registers: [registry],
   });
   ```

2. **Middleware**
   - Wrap tRPC/API routes to track request metrics
   - Track duration with histograms

3. **Metrics Endpoint**

   ```
   GET /metrics → Prometheus text format
   ```

   - Protect with basic auth or internal-only

4. **Grafana Dashboards**
   - API performance dashboard
   - Feed health dashboard
   - Job queue dashboard

---

### 4.3 Content Cleaning (Readability)

**Dependencies**: None

**Library**: `@mozilla/readability` + `jsdom`

**Implementation**:

1. **Readability Service**

   ```typescript
   import { Readability } from "@mozilla/readability";
   import { JSDOM } from "jsdom";

   interface CleanedContent {
     title: string;
     content: string; // cleaned HTML
     textContent: string; // plain text
     excerpt: string;
     byline?: string;
   }

   function cleanContent(html: string, url: string): CleanedContent | null;
   ```

2. **When to Clean**
   - Option A: Clean on fetch (store both original and cleaned)
   - Option B: Clean on demand (lazy, saves storage)
   - **Recommendation**: Clean on fetch, store in `content_cleaned`

3. **Entry Processing Update**
   - After parsing entry content, run through Readability
   - Store original in `content_original`, cleaned in `content_cleaned`
   - Generate `summary` from cleaned text content

4. **Fallback**
   - If Readability fails (returns null), use original content
   - Log failures for monitoring

5. **Full Article Fetch** (optional enhancement)
   - For feeds with summaries only, fetch full article from URL
   - Run through Readability
   - Requires user opt-in (bandwidth/privacy considerations)

**Schema** (already exists):

```sql
-- entries table already has:
content_original text,
content_cleaned text,
summary text,
```

---

## Implementation Order

Recommended order within each phase:

### Phase 2 (User Acquisition)

1. **OPML Import/Export** - Quick win, unblocks migrations
2. **Google OAuth** - Highest impact auth
3. **Apple OAuth** - Complete auth story
4. **Keyboard Shortcuts** - Polish for power users

### Phase 3 (Organization)

1. **Tags** - Most requested org feature
2. **JSON Feed** - Quick add to parser
3. **Feed Discovery** - Improves subscribe UX

### Phase 4 (Scale)

1. **Prometheus Metrics** - Visibility before optimization
2. **Content Cleaning** - User-facing improvement
3. **WebSub** - Reduces polling load (implement last, most complex)

---

## Testing Strategy

### Unit Tests (no mocks)

- OPML parser (XML → feeds)
- OPML generator (feeds → XML)
- JSON Feed parser
- Feed discovery (HTML → feed URLs)
- Readability wrapper
- Metrics calculations

### Integration Tests

- OAuth flows (with test credentials)
- OPML import creating subscriptions
- Tag CRUD and filtering
- WebSub subscription lifecycle
- Metrics endpoint

---

## Environment Variables (New)

```bash
# OAuth - Google (optional, omit to disable)
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=

# OAuth - Apple (optional, omit to disable)
APPLE_CLIENT_ID=
APPLE_TEAM_ID=
APPLE_KEY_ID=
APPLE_PRIVATE_KEY=

# Metrics (optional, defaults to disabled)
METRICS_ENABLED=false
METRICS_AUTH_USER=
METRICS_AUTH_PASSWORD=
```

---

## Self-Hosting: Optional Features

All Phase 2-4 features are designed to be optional for self-hosters. The app works fully with just Postgres and Redis.

### Feature Availability Matrix

| Feature                | Required Config                             | If Missing                                       |
| ---------------------- | ------------------------------------------- | ------------------------------------------------ |
| **Google OAuth**       | `GOOGLE_CLIENT_ID` + `GOOGLE_CLIENT_SECRET` | Button hidden, email/password still works        |
| **Apple OAuth**        | `APPLE_CLIENT_ID` + related vars            | Button hidden, email/password still works        |
| **Prometheus Metrics** | `METRICS_ENABLED=true`                      | `/metrics` returns 404, no overhead              |
| **Grafana**            | External service                            | Not required - metrics endpoint works standalone |
| **WebSub**             | Public URL for callbacks                    | Falls back to polling (works behind NAT)         |
| **Content Cleaning**   | None                                        | Always available (uses bundled Readability.js)   |
| **OPML/Tags/Keyboard** | None                                        | Always available                                 |

### Implementation Guidelines

#### OAuth: Runtime Detection

```typescript
// src/server/auth/oauth/config.ts
export const oauthProviders = {
  google: {
    enabled: !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET),
    clientId: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
  },
  apple: {
    enabled: !!(process.env.APPLE_CLIENT_ID && process.env.APPLE_PRIVATE_KEY),
    // ... other config
  },
};

export function getEnabledProviders(): string[] {
  return Object.entries(oauthProviders)
    .filter(([_, config]) => config.enabled)
    .map(([name]) => name);
}
```

```typescript
// API endpoint to get available providers
// GET /v1/auth/providers → { providers: ['google', 'apple'] } or { providers: [] }
```

```typescript
// UI: Only show buttons for enabled providers
const { data } = trpc.auth.providers.useQuery();

return (
  <div>
    {data?.providers.includes('google') && <GoogleSignInButton />}
    {data?.providers.includes('apple') && <AppleSignInButton />}
    {/* Email/password always shown */}
    <EmailPasswordForm />
  </div>
);
```

#### Metrics: Conditional Middleware

```typescript
// src/server/metrics/index.ts
export const metricsEnabled = process.env.METRICS_ENABLED === "true";

// Only register collectors if enabled (avoid overhead)
if (metricsEnabled) {
  collectDefaultMetrics({ register: registry });
}

// Middleware only tracks if enabled
export function trackRequest(/* ... */) {
  if (!metricsEnabled) return;
  // ... tracking logic
}
```

```typescript
// src/app/api/metrics/route.ts
import { metricsEnabled, registry } from "@/server/metrics";

export async function GET(req: Request) {
  if (!metricsEnabled) {
    return new Response("Metrics disabled", { status: 404 });
  }

  // Optional: basic auth protection
  if (process.env.METRICS_AUTH_USER) {
    const auth = req.headers.get("authorization");
    if (!validateBasicAuth(auth)) {
      return new Response("Unauthorized", { status: 401 });
    }
  }

  const metrics = await registry.metrics();
  return new Response(metrics, {
    headers: { "Content-Type": registry.contentType },
  });
}
```

#### WebSub: Graceful Fallback

```typescript
// src/server/feed/websub.ts
export function canUseWebSub(): boolean {
  // WebSub requires a publicly accessible callback URL
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL;
  if (!baseUrl) return false;

  // Don't attempt WebSub for localhost/private IPs
  const url = new URL(baseUrl);
  if (url.hostname === "localhost" || url.hostname === "127.0.0.1") {
    return false;
  }

  return true;
}

// In feed subscription logic
async function subscribeToFeed(feed: Feed) {
  if (feed.hubUrl && canUseWebSub()) {
    try {
      await subscribeWebSub(feed);
    } catch (error) {
      logger.warn("WebSub subscription failed, falling back to polling", {
        feedId: feed.id,
        error: error.message,
      });
      // Continue with polling - not a fatal error
    }
  }

  // Always schedule polling as fallback
  await scheduleNextFetch(feed);
}
```

### Documentation for Self-Hosters

Add to README or DEPLOYMENT.md:

````markdown
## Optional Features

Lion Reader works with just Postgres and Redis. These features are optional:

### OAuth Login (Google/Apple)

Adds "Sign in with Google/Apple" buttons. Without configuration,
users can still register with email/password.

To enable:

1. Create OAuth credentials with your provider
2. Set environment variables (see .env.example)
3. Buttons appear automatically

### Prometheus Metrics

Exposes a `/metrics` endpoint for monitoring. Disabled by default.

To enable:

```bash
METRICS_ENABLED=true
METRICS_AUTH_USER=admin        # optional basic auth
METRICS_AUTH_PASSWORD=secret
```
````

### WebSub Push

Reduces polling by receiving push updates from supporting feeds.
Requires a publicly accessible URL. Falls back to polling automatically
if running behind NAT or on localhost.

```

---

## Migration Notes

### Database Migrations

1. **oauth_accounts table** - New table, no data migration
2. **tags + subscription_tags tables** - New tables
3. **Remove folder column** - Drop if exists (MVP doesn't use it)
4. **websub_subscriptions table** - New table
5. **feeds.hub_url column** - Add column
6. **feed_type enum** - Add 'json' value

### Breaking Changes

None expected - all changes are additive.
```
