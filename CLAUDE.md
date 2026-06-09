# Lion Reader Development Guidelines

## Primary documentation

Aggressively keep this up-to-date if you notice anything outdated!

- @docs/DESIGN.md - Aggressively keep this up-to-date if you notice anything outdated!
- @docs/diagrams/ - Flow diagrams for various systems

ALWAYS read the relevant documentation before working.

## Reference documentation

Read these if you need context on features or specific references.

- @docs/features - Feature specs (may be outdated)
- @docs/references/ - Reference docs for external tools. Consult before editing related configs.

## Commands

- `pnpm typecheck` - Run before committing (no `any`, no `@ts-ignore`)
- `pnpm test:unit` - Pure logic tests (fast, no DB)
- `pnpm test:integration` - Backend tests against real Postgres/Redis (docker-compose)
- `pnpm test:e2e` - Playwright browser tests against a real app server (docker-compose)

## Code Quality

- **Types**: Explicit types everywhere; use Zod for runtime validation
- **Queries**: Avoid N+1 queries; use joins or batch fetching
- **UI**: Use optimistic updates for responsive UX
- **DRY**: Deduplicate logic that must stay in sync; don't merge code that merely looks similar but serves independent purposes
- Always write tests for the intended behavior of functions, not the actual behavior. If the actual behavior is wrong and the issue is pre-existing, write the test correctly, mark it skipped, and file a GitHub issue on brendanlong/clawed-burrow
- Don't create barrel files, prefer direct imports within our code

## Frontend Testing

The realtime SSE/cache-update code is the hardest part of the app to verify by review — always test it instead:

- **Cache logic** (`src/lib/cache/`): pure functions, unit-tested in `tests/unit/frontend/cache/` against real `QueryClient` instances using the factories in `tests/utils/cache-test-helpers.ts`. Add cases there when changing cache operations or event handling.
- **SSE → cache → UI pipeline**: covered by `tests/e2e/` Playwright tests, which seed the test DB directly, publish real Redis pub/sub events, and assert the UI updates **without** refetching (`recordTrpcProcedures` in `tests/e2e/helpers.ts`). When changing the realtime flow, run `pnpm test:e2e` and add scenarios using those helpers.
- **The minimal-request invariant**: SSE events must patch the React Query cache directly, never trigger `entries.*` refetches. `src/FRONTEND_STATE.md` is the contract for which queries get direct updates vs invalidation — read and update it when changing queries, mutations, or SSE handling.

For manual verification, `pnpm test:e2e` starts the app server on port 4983 against the test database; you can also seed data with the helpers and inspect pages with Playwright directly.

## UI Components

See @src/components/CLAUDE.md for UI component guidelines, available components, and icons.

## Git

- Break work into commit-sized chunks; commit when finished
- Use amend commits when it makes sense (ALWAYS check the current commit before amending)
- Main branch: `master`
- Commit `migrations/schema.sql` changes separately if unrelated to current work

## GitHub Issues

When you mention GitHub issues:

1. **Fetch the issues** - Use the GitHub API to list issues: `https://api.github.com/repos/brendanlong/lion-reader/issues`
2. **Read relevant issues** - Fetch detailed issue content via the API to understand requirements and discussion
3. **Reference in commits** - Include issue numbers in commit messages (e.g., "Fix: prevent over-fetching slow feeds (#175)") when applicable

## Project Structure

```
src/server/
  trpc/routers/  # tRPC API endpoints
  services/      # Reusable business logic (shared across APIs)
  db/            # Database schemas and client
  jobs/          # Background job queue
  plugins/       # Content source plugins (LessWrong, Google Docs, ArXiv, GitHub)
  mcp/           # MCP server
src/lib/         # Shared utilities (client and server)
src/components/  # React components
src/app/         # Next.js routes
tests/unit/      # Pure logic tests (no mocks, no DB)
tests/integration/ # Real DB via docker-compose (no mocks)
tests/e2e/       # Playwright browser tests (real server + DB + Redis)
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
- **`visible_entries`**: Entries with visibility rules applied. Use for `entries.list/get/count`. Includes read/starred state and subscription_id. An entry is visible if a `user_entries` row exists for the `(user, entry)` pair AND (the entry is from an active subscription OR is starred). Privacy gating happens when `user_entries` rows are inserted (subscribe-time / fetch-time), not in the view. See "Entry Visibility" in docs/DESIGN.md.

These views are defined in `migrations/0035_subscription_views.sql` and have Drizzle schemas in `src/server/db/schema.ts`.

## API Conventions

- **Pagination**: Always cursor-based (never offset)
- **tRPC naming**: `noun.verb` (e.g., `entries.list`, `entries.markRead`)

## Services Layer

Business logic should be extracted into reusable service functions in `src/server/services/`:

- **Purpose**: Share logic between tRPC routers, MCP server, background jobs, etc.
- **Pattern**: Pure functions that accept `db` and parameters, return plain data objects
- **Location**: `src/server/services/{domain}.ts` (e.g., `entries.ts`, `subscriptions.ts`)
- **Naming**: `verbNoun` (e.g., `listEntries`, `searchSubscriptions`, `markEntriesRead`)

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
