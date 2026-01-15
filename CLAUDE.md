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

### Subscription Views

Use the database views for frontend queries instead of manual joins:

- **`user_feeds`**: Active subscriptions with feed data merged. Use for `subscriptions.list/get/export`. Already filters out unsubscribed entries and resolves title (custom or original).
- **`visible_entries`**: Entries with visibility rules applied. Use for `entries.list/get/count`. Includes read/starred state and subscription_id. An entry is visible if it's from an active subscription OR is starred.

These views are defined in `drizzle/0035_subscription_views.sql` and have Drizzle schemas in `src/server/db/schema.ts`.

## API Conventions

- **Pagination**: Always cursor-based (never offset); return `{ items: T[], nextCursor?: string }`
- **tRPC naming**: `noun.verb` (e.g., `entries.list`, `entries.markRead`)

## Frontend State Management

### Zustand Delta-Based Architecture

The app uses Zustand for optimistic updates, storing only **deltas** from the server state (e.g., "entry X is now read"). React Query provides the base data, Zustand applies deltas on top.

### Mutation Hooks: subscriptionId Passthrough Pattern

**CRITICAL**: Entry mutations (markRead, toggleStar) need `subscriptionId` to update unread counts correctly. **Always pass subscriptionId as a parameter** through the callback chain—do NOT use cache lookups.

**Type Safety**: `subscriptionId` is **required (but nullable)** in all callback signatures—TypeScript enforces this at compile time. You cannot accidentally forget to pass it.

#### Implementation Pattern

Page components should create a wrapper that looks up tags and passes both subscriptionId and tagIds:

```typescript
// In page component: look up subscriptionId's tags and pass to mutation
const subscriptionsQuery = trpc.subscriptions.list.useQuery();

const handleToggleRead = useCallback(
  (entryId: string, currentlyRead: boolean, subscriptionId: string | null) => {
    if (!subscriptionId) {
      // No subscription - saved article or starred entry from deleted subscription
      toggleRead(entryId, currentlyRead);
      return;
    }
    // Look up tags for this subscription
    const subscription = subscriptionsQuery.data?.items.find((sub) => sub.id === subscriptionId);
    const tagIds = subscription?.tags.map((tag) => tag.id);
    toggleRead(entryId, currentlyRead, subscriptionId, tagIds);
  },
  [toggleRead, subscriptionsQuery.data]
);

// Pass handleToggleRead to keyboard shortcuts and EntryList
<EntryList onToggleRead={handleToggleRead} />
```

#### Component Chain

The callback signature flows through:

1. **Page** → creates `handleToggleRead` wrapper with tag lookup
2. **EntryList** → passes through to EntryListItem
3. **EntryListItem** → passes through to ArticleListItem
4. **ArticleListItem** → calls `onToggleRead(entryId, read, subscriptionId)`

The same pattern applies to:

- **useKeyboardShortcuts**: Gets subscriptionId from entry data, passes to onToggleRead
- **EntryContent**: Uses `useEntryMutations({ subscriptionId, tagIds })` with known context

#### Why This Matters

- Without subscriptionId: ⚠️ Mutation works but unread counts don't update
- With subscriptionId: ✅ Zustand correctly updates counts for subscription + all its tags
- Development mode shows warnings when subscriptionId is missing

#### What NOT to Do

❌ **Don't** try to look up subscriptionId from cache in mutation hooks (fragile, prone to query key mismatches)
✅ **Do** pass subscriptionId explicitly through callbacks from components that have the data

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
