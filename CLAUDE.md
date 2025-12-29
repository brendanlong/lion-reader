# Lion Reader Development Guidelines

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

## Performance Guidelines

- Avoid N+1 queries - use joins or batch fetching
- Add database indexes for common query patterns
- Use Redis for caching hot data (sessions, rate limits)
- Keep API responses small - use pagination, select specific fields
