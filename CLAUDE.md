# Lion Reader Development Guidelines

## Primary documentation

Aggressively keep this up-to-date if you notice anything outdated!

- @docs/DESIGN.md - Aggressively keep this up-to-date if you notice anything outdated!
- @docs/README.md - High-level project info
- @docs/diagrams/ - Flow diagrams for various systems

ALWAYS read the relevant documentation before working.

## Reference documentation

Read these if you need context on features or specific references.

- @docs/features - Feature specs (may be outdated)
- @docs/references/ - Reference docs for external tools. Consult before editing related configs.

## Commands

- `pnpm typecheck` - Run before committing (no `any`, no `@ts-ignore`)

## Code Quality

- **Types**: Explicit types everywhere; use Zod for runtime validation
- **Queries**: Avoid N+1 queries; use joins or batch fetching
- **UI**: Use optimistic updates for responsive UX
- **DRY**: Deduplicate logic that must stay in sync; don't merge code that merely looks similar but serves independent purposes

## UI Components

See @src/components/CLAUDE.md for UI component guidelines, available components, and icons.

## Git

- Break work into commit-sized chunks; commit when finished
- Use amend commits when it makes sense (ALWAYS check the current commit before amending)
- Main branch: `master`
- Commit `drizzle/schema.sql` changes separately if unrelated to current work

## Project Structure

```
src/server/
  trpc/routers/  # tRPC API endpoints
  services/      # Reusable business logic (shared across APIs)
  db/            # Database schemas and client
  jobs/          # Background job queue
  mcp/           # MCP server (if present)
src/lib/         # Shared utilities (client and server)
src/components/  # React components
src/app/         # Next.js routes
tests/unit/      # Pure logic tests (no mocks, no DB)
tests/integration/ # Real DB via docker-compose (no mocks)
```

See docs/diagrams/ for more detail. These diagrams are very helpful for quickly understanding the codebase.

## Database Conventions

- **IDs**: UUIDv7, generated in TypeScript via `generateUuidv7()` from `@/lib/uuidv7`. `gen_uuidv7()` is not available in our Postgres version.
- **Timestamps**: `timestamptz`, store UTC
- **Soft deletes**: Use `deleted_at`/`unsubscribed_at` patterns
- **Upserts**: Prefer `onConflictDoNothing()`/`onConflictDoUpdate()` over check-then-act
- **Background jobs**: Postgres-based queue
- **Caching/SSE**: Redis available for caching and coordinating SSE

### Subscription Views

Use the database views for frontend queries instead of manual joins:

- **`user_feeds`**: Active subscriptions with feed data merged. Use for `subscriptions.list/get/export`. Already filters out unsubscribed entries and resolves title (custom or original).
- **`visible_entries`**: Entries with visibility rules applied. Use for `entries.list/get/count`. Includes read/starred state and subscription_id. An entry is visible if it's from an active subscription OR is starred.

These views are defined in `drizzle/0035_subscription_views.sql` and have Drizzle schemas in `src/server/db/schema.ts`.

## API Conventions

- **Pagination**: Always cursor-based (never offset)
- **tRPC naming**: `noun.verb` (e.g., `entries.list`, `entries.markRead`)

## Services Layer

Business logic should be extracted into reusable service functions in `src/server/services/`:

- **Purpose**: Share logic between tRPC routers, MCP server, background jobs, etc.
- **Pattern**: Pure functions that accept `db` and parameters, return plain data objects
- **Location**: `src/server/services/{domain}.ts` (e.g., `entries.ts`, `subscriptions.ts`)
- **Naming**: `verbNoun` (e.g., `listEntries`, `searchSubscriptions`, `markEntriesRead`)

## Frontend State Management

### Zustand Delta-Based Architecture

The app uses Zustand for optimistic updates, storing only **deltas** from the server state (e.g., "entry X is now read"). React Query provides the base data, Zustand applies deltas on top.

Don't try to invalidate the cache or look things up in the cache. Pass data down as props if needed (and add to the backend API if necessary).

## Outgoing HTTP Requests

Always use our custom user agent.

```typescript
import { USER_AGENT, buildUserAgent } from "@/server/http/user-agent";
headers: { "User-Agent": USER_AGENT }
```

## Parsing

Prefer SAX-style parsing unless the algorithm requires a DOM.

- XML/RSS: `fast-xml-parser` (streaming)
- HTML extraction: `htmlparser2` (streaming)
- DOM required (Readability): `linkedom`
- Parse once, pass parsed structure through code
