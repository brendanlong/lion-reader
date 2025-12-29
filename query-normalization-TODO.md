# Query Normalization Implementation Checklist

Each task below is designed to be a self-contained PR. Complete them in order.

Read @docs/query-normalization-plan.md before starting.

## Phase 1: Setup Normy

### 1.1 Install and Configure Normy

- [ ] **Add normy dependency and provider**
  - Run `pnpm add @normy/react-query`
  - Update `src/lib/trpc/provider.tsx` to wrap with `QueryNormalizerProvider`
  - Verify app still works (no regressions)
  - Run `pnpm typecheck` and `pnpm test`

## Phase 2: Update Mutations to Return Entry Data

### 2.1 Update markRead Mutation

- [ ] **Return entry data from markRead mutation**
  - Update `src/server/trpc/routers/entries.ts` markRead procedure
  - Change output schema from `z.object({})` to include entries array
  - Query the updated entries after the update
  - Return `{ entries: [{ id, read, starred }, ...] }`
  - Update any client code that expects empty response
  - Write/update integration tests

### 2.2 Update star/unstar Mutations

- [ ] **Return entry data from star mutation**
  - Update `src/server/trpc/routers/entries.ts` star procedure
  - Query the entry after update
  - Return `{ entry: { id, read, starred } }`
  - Update client code if needed

- [ ] **Return entry data from unstar mutation**
  - Update `src/server/trpc/routers/entries.ts` unstar procedure
  - Query the entry after update
  - Return `{ entry: { id, read, starred } }`
  - Update client code if needed

## Phase 3: Simplify Client Cache Code

### 3.1 Remove Manual Cache Sync in EntryContent

- [ ] **Remove updateEntryInAllLists from EntryContent**
  - Remove `updateEntryInAllLists` callback function (~40 lines)
  - Simplify markReadMutation to only update current query (normy propagates)
  - Simplify starMutation/unstarMutation similarly
  - Test: mark unread in article view → list view shows unread
  - Test: star in article view → starred list includes it

### 3.2 Simplify Page Mutations

- [ ] **Simplify all/page.tsx mutations**
  - Remove manual updates to `entries.get` queries
  - Keep optimistic update to current list query (normy propagates to others)
  - Test: mark read in list → article view shows read

- [ ] **Simplify feed/[feedId]/page.tsx mutations**
  - Same changes as all/page.tsx
  - Test: changes propagate to /all view

- [ ] **Simplify starred/page.tsx mutations**
  - Same changes as all/page.tsx
  - Test: changes propagate to /all view

- [ ] **Simplify tag/[tagId]/page.tsx mutations**
  - Same changes as all/page.tsx
  - Test: changes propagate to /all view

## Phase 4: (Optional) Consolidate Mutation Logic

### 4.1 Create Shared Mutation Hook

- [ ] **Create useEntryMutations hook**
  - Create `src/lib/hooks/useEntryMutations.ts`
  - Implement markRead, toggleRead, star, unstar, toggleStar
  - Handle optimistic updates in one place
  - Handle errors with toast notifications
  - Export from `src/lib/hooks/index.ts`

- [ ] **Migrate pages to use shared hook**
  - Update all/page.tsx to use useEntryMutations
  - Update feed/[feedId]/page.tsx to use useEntryMutations
  - Update starred/page.tsx to use useEntryMutations
  - Update tag/[tagId]/page.tsx to use useEntryMutations
  - Update EntryContent.tsx to use useEntryMutations
  - Remove duplicated mutation code from each file

## Phase 5: Testing & Polish

### 5.1 End-to-End Testing

- [ ] **Test cross-view synchronization**
  - Test: Mark unread in article → back to list → shows unread
  - Test: Mark read in /all → navigate to /feed → shows read
  - Test: Star in /feed → navigate to /starred → appears in list
  - Test: Unstar in /starred → navigate to /all → star indicator gone
  - Test: Optimistic updates are instant (no flicker)
  - Test: Error rollback works (disable network, try action)

### 5.2 Cleanup

- [ ] **Remove unused code**
  - Search for any remaining `updateEntryInAllLists` references
  - Search for any remaining manual `entries.get.setData` in mutations
  - Remove dead code
  - Run `pnpm typecheck` and `pnpm lint`
