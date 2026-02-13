# Query Normalization Design

> **Note (2026-02):** This plan has been superseded by the migration to TanStack DB collections (Phases 4-6). Entry data is now managed through TanStack DB collections rather than React Query cache entries, eliminating the cross-query duplication problem. See `src/lib/collections/` for the current architecture.

## Problem

Entry data is duplicated across multiple React Query cache entries:

- `entries.list({ unreadOnly: true })` - one copy
- `entries.list({ feedId: 'abc' })` - another copy
- `entries.list({ starredOnly: true })` - another copy
- `entries.get({ id: 'xyz' })` - yet another copy

When marking an entry as read/unread, the current code attempts to update all cached queries manually via `updateEntryInAllLists()`, but this is fragile and doesn't work reliably. The result: marking an entry unread from the article view doesn't reflect in the list view until page refresh.

## Solution

Use [@normy/react-query](https://github.com/klis87/normy) for automatic cache normalization. When an entry is updated in any query, normy automatically propagates the change to all other queries containing that entry.

### How Normy Works

Normy intercepts React Query cache operations and maintains a normalized store internally. Objects with an `id` field are stored by ID, and when any query returns or updates an object, normy merges the changes across all cached queries containing that object.

```
┌─────────────────────────────────────────────────────────────┐
│                    React Query Cache                         │
│  ┌─────────────────┐  ┌─────────────────┐  ┌──────────────┐ │
│  │ entries.list    │  │ entries.list    │  │ entries.get  │ │
│  │ (unreadOnly)    │  │ (feedId: abc)   │  │ (id: xyz)    │ │
│  └────────┬────────┘  └────────┬────────┘  └──────┬───────┘ │
│           │                    │                   │         │
│           └────────────────────┼───────────────────┘         │
│                                ▼                             │
│                    ┌───────────────────┐                     │
│                    │  Normy Normalizer │                     │
│                    │  (entries by ID)  │                     │
│                    └───────────────────┘                     │
└─────────────────────────────────────────────────────────────┘

When entry xyz is updated anywhere, normy propagates to all queries.
```

## Prerequisites

### 1. Globally Unique IDs

Normy requires IDs to be unique across the entire app, not just per entity type.

**Status: ✅ Already satisfied** - We use UUIDv7 for all primary keys, which are globally unique by design.

### 2. Consistent Object Structure

Objects should have the same field names across queries (though they can have different subsets of fields).

**Status: ✅ Already satisfied** - Both `entries.list` and `entries.get` use the same field names (`id`, `read`, `starred`, etc.). The list just has fewer fields.

### 3. Mutation Responses Return Updated Data

Normy can automatically update caches when mutations return the updated object data.

**Status: ❌ Needs change** - Current mutations return `{}`. We need to return the updated entry data so normy can propagate changes.

## Implementation

### Step 1: Install Normy

```bash
pnpm add @normy/react-query
```

### Step 2: Configure QueryNormalizerProvider

Wrap the app with `QueryNormalizerProvider` in `src/lib/trpc/provider.tsx`:

```typescript
import { QueryNormalizerProvider } from '@normy/react-query';

// Wrap QueryClientProvider
<QueryNormalizerProvider queryClient={queryClient}>
  <QueryClientProvider client={queryClient}>
    {children}
  </QueryClientProvider>
</QueryNormalizerProvider>
```

### Step 3: Update Mutations to Return Entry Data

Change mutations in `src/server/trpc/routers/entries.ts` to return the updated entries:

**markRead**:

```typescript
// Before: return {};
// After:
return {
  entries: updatedEntries.map((e) => ({
    id: e.id,
    read: input.read,
    starred: e.starred,
  })),
};
```

**star/unstar**:

```typescript
// Before: return {};
// After:
return {
  entry: { id: input.id, read: entry.read, starred: true / false },
};
```

### Step 4: Simplify Optimistic Updates

With normy, optimistic updates to ANY query automatically propagate to all other queries. The existing code that updates the current list query will now automatically update:

- Other list queries (different filters)
- The individual `entries.get` query

We can remove:

- `updateEntryInAllLists()` function in EntryContent.tsx
- Manual updates to `entries.get` in each page's mutations
- Duplicated mutation definitions across pages (can consolidate into a shared hook)

### Step 5: (Optional) Create Shared Mutation Hook

To reduce duplication, create `src/lib/hooks/useEntryMutations.ts`:

```typescript
export function useEntryMutations() {
  const utils = trpc.useUtils();

  const markRead = trpc.entries.markRead.useMutation({
    onMutate: async (variables) => {
      await utils.entries.list.cancel();
      // Update current list - normy propagates automatically
      utils.entries.list.setInfiniteData(/* current filters */, (old) => /* update */);
    },
    onError: () => {
      utils.entries.list.invalidate();
      toast.error("Failed to update");
    },
    onSettled: () => utils.subscriptions.list.invalidate(),
  });

  // Similar for star, unstar...

  return { markRead, star, unstar, toggleRead, toggleStar };
}
```

## Partial Data Handling

List queries return a subset of fields:

- **List**: id, feedId, url, title, author, summary, publishedAt, fetchedAt, read, starred, feedTitle
- **Get**: Same + contentOriginal, contentCleaned, feedUrl

Normy handles this correctly by **merging** fields. If you have:

1. List returns `{ id: '1', read: false, title: 'Foo' }`
2. Get returns `{ id: '1', read: false, contentOriginal: '...' }`

Normy stores: `{ id: '1', read: false, title: 'Foo', contentOriginal: '...' }`

When you update `read: true` via mutation, it propagates to both queries.

## Files Changed

| File                                      | Change                              |
| ----------------------------------------- | ----------------------------------- |
| `src/lib/trpc/provider.tsx`               | Add QueryNormalizerProvider wrapper |
| `src/server/trpc/routers/entries.ts`      | Return entry data from mutations    |
| `src/app/(app)/all/page.tsx`              | Remove manual cache sync code       |
| `src/app/(app)/feed/[feedId]/page.tsx`    | Remove manual cache sync code       |
| `src/app/(app)/starred/page.tsx`          | Remove manual cache sync code       |
| `src/app/(app)/tag/[tagId]/page.tsx`      | Remove manual cache sync code       |
| `src/components/entries/EntryContent.tsx` | Remove updateEntryInAllLists        |
| `src/lib/hooks/useEntryMutations.ts`      | (Optional) Create shared hook       |

## Trade-offs

| Aspect                  | Benefit                                  | Cost                                  |
| ----------------------- | ---------------------------------------- | ------------------------------------- |
| Automatic propagation   | Update one query → all queries sync      | New dependency (~10KB gzipped)        |
| Keep optimistic updates | Instant UI feedback preserved            | Need to update one query per mutation |
| Mutations return data   | Normy can also sync from server response | ~5 more fields returned per mutation  |
| Magic                   | Less code to maintain                    | Harder to debug if issues arise       |

## Fallback

If normy causes issues with specific queries, we can:

1. Exclude them from normalization via config
2. Add manual `setQueryData` calls for edge cases
3. Fall back to invalidation for problematic queries

Normy doesn't prevent mixing approaches.

## References

- [Normy GitHub](https://github.com/klis87/normy)
- [@normy/react-query npm](https://www.npmjs.com/package/@normy/react-query)
- [React Query docs on manual cache updates](https://tanstack.com/query/latest/docs/framework/react/guides/updates-from-mutation-responses)
