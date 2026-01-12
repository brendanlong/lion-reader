# Lion Reader Development Guidelines

## Documentation

- `docs/` - Design documents and feature specs (may be outdated)
- `docs/references/` - Reference docs for external tools. Consult before editing related configs.

## Commands

- `pnpm typecheck` - Run before committing (no `any`, no `@ts-ignore`)

## Code Quality

- **Types**: Explicit types everywhere; use Zod for runtime validation
- **Queries**: Avoid N+1 queries; use joins or batch fetching
- **UI**: Use optimistic updates for responsive UX

## Git

- Break work into commit-sized chunks; commit when finished
- Use amend commits when it makes sense
- Main branch: `master`
- Commit `drizzle/schema.sql` changes separately if unrelated to current work

## Project Structure

```
src/server/     # Server-only (tRPC routers, DB, background jobs)
src/lib/        # Shared utilities (client and server)
src/components/ # React components
src/app/        # Next.js routes
tests/unit/     # Pure logic tests (no mocks, no DB)
tests/integration/ # Real DB via docker-compose (no mocks)
```

## Database Conventions

- **IDs**: UUIDv7 via `gen_uuidv7()` - time-ordered, so `ORDER BY id DESC` = reverse chronological
- **Timestamps**: Always `timestamptz`, store UTC
- **Soft deletes**: Use `deleted_at`/`unsubscribed_at` patterns
- **Upserts**: Prefer `onConflictDoNothing()`/`onConflictDoUpdate()` over check-then-act
- **Background jobs**: Postgres-based queue
- **Caching/SSE**: Redis available for caching and coordinating SSE

## API Conventions

- **Pagination**: Always cursor-based (never offset); return `{ items: T[], nextCursor?: string }`
- **tRPC naming**: `noun.verb` (e.g., `entries.list`, `entries.markRead`)

## Outgoing HTTP Requests

```typescript
import { USER_AGENT, buildUserAgent } from "@/server/http/user-agent";
headers: { "User-Agent": USER_AGENT }
// Or with context: buildUserAgent({ context: `feed:${feedId}` })
```

## Parsing

- XML/RSS: `fast-xml-parser` (streaming)
- HTML extraction: `htmlparser2` (streaming)
- DOM required (Readability): `linkedom`
- Parse once, pass parsed structure through code
