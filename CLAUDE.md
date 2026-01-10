# Lion Reader Development Guidelines

## Documentation

- `docs/` - Design documents and feature specs (feature docs were written at design time and may be outdated)
- `docs/references/` - Reference documentation for external tools we use. Always consult these before editing related config files to avoid hallucinating invalid options.

## Coding

- When you're done with a task, always commit the changes. If more changes are needed, you can always
  amend the commit (but generally prefer to make a new commit if it makes sense)

## Type Safety

- **All non-test code must be fully type checked** - no `any`, no `// @ts-ignore`, no implicit any
- Run `pnpm typecheck` (tsc --noEmit) before committing
- Use Zod schemas for runtime validation at system boundaries (API inputs, external data)
- Prefer `unknown` over `any` when type is truly unknown, then narrow with type guards

## Testing Philosophy

### Unit Tests vs Integration Tests

**Unit tests** are for pure business logic with no I/O:

- Feed parsing (XML → ParsedFeed)
- Cache header interpretation
- Next fetch time calculation
- Entry diffing / change detection
- Rate limit decisions
- Any pure function that transforms data

**Integration tests** are for code that touches external systems:

- Database queries and transactions
- Redis operations
- HTTP endpoints (tRPC routes)
- Background job execution
- Full user flows (register → subscribe → read)

### Mocking Approach

**We avoid mocks.** Structure code so they're not needed:

1. **Separate pure logic from I/O** - Pure functions are easy to unit test, I/O is tested via integration tests
2. **Use real databases in integration tests** - docker-compose provides Postgres and Redis
3. **Don't mock internal code** - If you need to mock your own code, refactor it instead

```typescript
// GOOD: Pure function, easy to unit test
function calculateNextFetch(cacheControl: CacheHeaders, lastFetch: Date): Date;

// GOOD: I/O function, test with real DB in integration tests
async function fetchFeed(url: string): Promise<FetchResult>;

// BAD: Mixed concerns, would need mocks to test
async function fetchAndCalculateNext(feedId: string): Promise<Date> {
  const feed = await db.getFeed(feedId); // I/O mixed with logic
  // ...
}
```

**Exceptions where mocks are acceptable:**

- External HTTP APIs in integration tests (use a test server or recorded responses)
- Time-dependent code (inject a clock abstraction)
- Third-party services we don't control (email providers, OAuth providers)

### Test File Organization

```
tests/
  unit/           # Fast, no I/O, run frequently
  integration/    # Requires Docker services, run in CI
```

## Code Structure

### Pure Logic at Core, I/O at Edges

```
┌─────────────────────────────────────────┐
│           I/O Layer (thin)              │  ← Integration tested
│  HTTP handlers, DB queries, Redis ops   │
└────────────────────┬────────────────────┘
                     │
┌────────────────────▼────────────────────┐
│         Pure Business Logic             │  ← Unit tested
│  Parsing, validation, calculations      │
└─────────────────────────────────────────┘
```

### Directory Conventions

- `src/server/` - Server-only code (tRPC routers, DB, background jobs)
- `src/lib/` - Shared utilities (both client and server)
- `src/components/` - React components
- `src/app/` - Next.js routes

## Database Conventions

### IDs

- Use **UUIDv7** for all primary keys (time-ordered, globally unique)
- Generate with `gen_uuidv7()` in Postgres or equivalent in TypeScript
- UUIDv7 ordering means `ORDER BY id DESC` gives reverse chronological order

### Timestamps

- Always use `timestamptz` (with timezone), never `timestamp`
- Store in UTC, convert to user timezone in frontend
- Use `created_at` and `updated_at` on all tables

### Soft Deletes

- Use `deleted_at` or `unsubscribed_at` patterns, not hard deletes
- Always filter these out in queries: `WHERE deleted_at IS NULL`

### Upsert Pattern ("Just Do It")

Default to attempting operations directly rather than checking state first:

```typescript
// GOOD: Just attempt the insert, handle conflict
await db.insert(tags).values({ ... }).onConflictDoNothing();

// GOOD: Delete with RETURNING to check if row existed
const deleted = await db.delete(tags).where(...).returning({ id: tags.id });
if (deleted.length === 0) throw errors.tagNotFound();

// BAD: Check-then-act (race conditions, extra round trip)
const existing = await db.select().from(tags).where(...);
if (existing.length > 0) throw errors.alreadyExists();
await db.insert(tags).values({ ... });
```

**Use this pattern when:**

- Creating records (INSERT ON CONFLICT DO NOTHING/UPDATE)
- Deleting records (DELETE ... RETURNING to verify existence)
- Updating records (UPDATE ... RETURNING to verify existence)

**Skip this pattern when:**

- Business logic requires inspecting the current state (e.g., soft-delete reactivation where you need to check `unsubscribedAt` value)
- The upsert would make the query significantly more complex
- You need to return different errors based on the current state

### Migrations

- **Write SQL migrations manually** in `drizzle/` folder - we don't use `drizzle-kit generate`
- Name migrations with incrementing prefix: `0016_descriptive_name.sql`
- Use `--> statement-breakpoint` to separate SQL statements
- **Enum additions must be in their own migration file** - PostgreSQL doesn't allow using new enum values in the same transaction they were added
- **Register every migration in `drizzle/meta/_journal.json`** - Migrations won't be applied unless they're listed in the journal. Add an entry with a unique `idx`, incrementing `when` timestamp, and `tag` matching the filename (without `.sql`). Each migration file must have a unique numeric prefix.
- Run migrations with `pnpm db:migrate`
- Apply to test database with `pnpm db:migrate:test`
- Use `pg_dump -s` to get schema context when writing migrations (env vars are loaded automatically)

## API Conventions

### Pagination

- Always cursor-based, never offset-based
- Return `{ items: T[], nextCursor?: string }`
- Cursor is opaque to client (base64-encoded ID or compound key)

### Error Responses

```typescript
{
  error: {
    code: string;       // 'UNAUTHORIZED', 'NOT_FOUND', 'VALIDATION_ERROR'
    message: string;    // Human-readable
    details?: object;   // Optional additional context
  }
}
```

### Naming

- tRPC procedures: `noun.verb` (e.g., `entries.list`, `entries.markRead`)
- REST endpoints: `HTTP_METHOD /v1/noun` (e.g., `GET /v1/entries`, `POST /v1/entries/mark-read`)

## Outgoing HTTP Requests

When making outgoing HTTP requests (fetching feeds, calling external APIs, downloading images), always set the `User-Agent` header using the centralized module:

```typescript
import { USER_AGENT, buildUserAgent } from "@/server/http/user-agent";

// For general requests
headers: { "User-Agent": USER_AGENT }

// For requests with context (e.g., feed fetching)
headers: { "User-Agent": buildUserAgent({ context: `feed:${feedId}` }) }
```

The User-Agent includes app version, git commit SHA, website URL, GitHub repo, and contact email - making it easy for external services to identify and contact us if needed.

## Git Conventions

- The main branch is named `master`
- Don't commit unless explicitly asked
- Commit messages: imperative mood, explain why not what
- One logical change per commit

## Background Jobs

- Use Postgres-based job queue (not Redis)
- Jobs are idempotent - safe to retry
- Set reasonable `max_attempts` (usually 3)
- Use exponential backoff for retries

## Feed Fetch Versioning

When making improvements to the RSS parser or content cleaning pipeline that affect how entries are processed, you need to force all feeds to be refetched and reparsed. This is done via the `CURRENT_FETCH_VERSION` constant in `src/server/jobs/handlers.ts`.

### How it works

1. Each feed has a `fetch_version` column tracking which version of the parser processed it
2. When `feed.fetchVersion < CURRENT_FETCH_VERSION`, the feed job:
   - Skips sending ETag/Last-Modified headers (forces full HTTP fetch)
   - Skips the body hash comparison (forces reparse even if content unchanged)
3. After successful processing, the feed's `fetch_version` is updated to `CURRENT_FETCH_VERSION`

### When to increment

Increment `CURRENT_FETCH_VERSION` when you:

- Fix bugs in the RSS/Atom parser that affect content extraction
- Improve the content cleaning/readability pipeline
- Change how entries are processed or stored
- Fix issues with date parsing, author extraction, etc.

### How to increment

1. Update the `CURRENT_FETCH_VERSION` constant in `src/server/jobs/handlers.ts`
2. Add a comment to the version history documenting what changed
3. The next scheduled fetch for each feed will automatically refetch without cache

## Performance Guidelines

- Avoid N+1 queries - use joins or batch fetching
- Add database indexes for common query patterns
- Use Redis for caching hot data (sessions, rate limits)
- Keep API responses small - use pagination, select specific fields

## React Query / tRPC Patterns

### Optimistic Updates

For mutations that update UI state (mark read, star, etc.), use optimistic updates:

- Cancel in-flight queries in `onMutate` to prevent race conditions
- Snapshot current state for rollback
- Update cache immediately with `setQueryData`/`setInfiniteData`
- Rollback in `onError` if mutation fails
- Show toast notification on errors

### Targeted Cache Updates vs Invalidation

- **Prefer `setQueryData`/`setInfiniteData`** for updating specific items in lists
- **Use `invalidate`** only when you need fresh server data (e.g., computed counts)
- Targeted updates are faster and avoid unnecessary refetches

## Android App

The Android app lives in `android/`. When adding new API endpoints to `LionReaderApiImpl`, also add them to `clientPaths` in `ApiContractTest` to ensure they're validated against the server's OpenAPI spec.
