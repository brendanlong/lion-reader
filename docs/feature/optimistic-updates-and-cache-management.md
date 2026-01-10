# Optimistic Updates and Cache Management Optimization

**Status:** Draft
**Created:** 2026-01-10
**Author:** Claude
**Related Issues:** N/A

## Overview

This document describes identified inefficiencies in our client-side cache management and proposes optimizations to reduce unnecessary network requests through optimistic updates and targeted cache mutations.

## Background

Lion Reader uses tRPC with React Query for client-server communication. Currently, many mutations invalidate entire query caches, triggering full refetches of data that could be updated optimistically or with targeted cache updates. This results in unnecessary network traffic and slower UI responsiveness.

### Current Architecture

- **tRPC mutations**: 34 mutations across 11 routers (subscriptions, entries, auth, tags, etc.)
- **SSE events**: 8 real-time event types for server-initiated updates
- **Cache strategy**: Mix of invalidation (most common) and optimistic updates (some mutations)

### Audit Findings

We conducted a comprehensive audit of all state mutations and found:

- **Well-optimized examples**: `entries.markRead`, `subscriptions.create`, `users.me.updatePreferences`
- **Critical bugs**: Auth mutations that don't update cache at all
- **Inefficiencies**: Many mutations invalidate entire lists when targeted updates would work
- **SSE inefficiencies**: Several events invalidate large caches when targeted updates are possible

## Problems Identified

### Critical: Auth Mutations Not Updating Cache

**Affected Mutations:**

- `auth.linkGoogle` (src/server/trpc/routers/auth.ts:540-618)
- `auth.linkApple` (src/server/trpc/routers/auth.ts:630-693)

**Problem:**
These mutations successfully link OAuth accounts but don't invalidate or update the `users.me.get` cache. Result: Linked accounts don't appear in UI until page refresh.

**Current Implementation:**

```typescript
// src/app/(app)/settings/account/page.tsx:100-124
const linkGoogleMutation = trpc.auth.linkGoogle.useMutation({
  onSuccess: () => {
    toast.success("Google account linked successfully");
  },
  // BUG: No cache update!
});
```

**Impact:** Broken user experience - users think the operation failed.

---

### High Priority: Entry Mutations

#### 1. entries.markAllRead - Invalidates Everything

**Location:** src/server/trpc/routers/entries.ts:890-1085

**Problem:**
Invalidates 4 separate query keys instead of using optimistic updates like `entries.markRead` does.

**Current Implementation:**

```typescript
// src/lib/hooks/useEntryMutations.ts:339-357
onSuccess: (data) => {
  utils.entries.list.invalidate();
  utils.entries.count.invalidate();
  utils.subscriptions.list.invalidate(); // For unread counts
  utils.tags.list.invalidate(); // For tag unread counts
};
```

**Efficient Approach (like markRead):**

```typescript
onSuccess: (data) => {
  // Server returns: { feedUnreadCounts: Record<feedId, newCount> }

  // Update subscription unread counts in place
  utils.subscriptions.list.setData(undefined, (old) => {
    if (!old) return old;
    return {
      items: old.items.map((item) => ({
        ...item,
        subscription: {
          ...item.subscription,
          unreadCount:
            data.feedUnreadCounts[item.subscription.feedId] ?? item.subscription.unreadCount,
        },
      })),
    };
  });

  // Update tags counts
  utils.tags.list.setData(undefined, (old) => {
    if (!old) return old;
    // Calculate new tag counts from updated subscription counts
    // ...
  });

  // Only invalidate entries.list (which needs filtering updates)
  utils.entries.list.invalidate();
};
```

**API Change Needed:** Server should return `feedUnreadCounts` like `markRead` does.

**Impact:** Eliminates 3 of 4 full refetches per operation.

#### 2. entries.star/unstar - Unnecessary Invalidations

**Location:** src/server/trpc/routers/entries.ts:1098-1218

**Problem:**
Invalidates `entries.starredCount` even when operation is on a single unstarred entry (or starred entry in unstar case).

**Current Implementation:**

```typescript
// src/lib/hooks/useEntryMutations.ts:169-234
onSuccess: (result) => {
  // Updates entry in entries.list using setInfiniteData ✅
  // But also invalidates starred list unnecessarily:
  if (!params.unreadOnly) {
    utils.entries.list.invalidate({ starred: true });
  }
  utils.entries.starredCount.invalidate(); // ❌ Always invalidates
};
```

**Efficient Approach:**

```typescript
onSuccess: (result) => {
  // Update count directly instead of invalidating
  utils.entries.starredCount.setData(undefined, (old) => {
    if (!old) return old;
    return old + (result.starred ? 1 : -1);
  });

  // Only invalidate starred list, not count
  if (!params.unreadOnly) {
    utils.entries.list.invalidate({ starred: true });
  }
};
```

**Impact:** Eliminates 1 query per star/unstar operation.

---

### High Priority: Tag Mutations

**Affected Mutations:**

- `tags.create` (src/server/trpc/routers/tags.ts:162-201)
- `tags.update` (src/server/trpc/routers/tags.ts:213-268)
- `tags.delete` (src/server/trpc/routers/tags.ts:280-323)
- `subscriptions.setTags` (src/server/trpc/routers/subscriptions.ts:542-685)

**Problem:**
All tag mutations use full cache invalidation instead of optimistic updates.

#### tags.create

**Current:** Invalidates `tags.list` (src/components/tags/TagManagementDialog.tsx:79)

**Efficient Approach:**

```typescript
onMutate: async (newTag) => {
  await utils.tags.list.cancel();
  const previousData = utils.tags.list.getData();

  utils.tags.list.setData(undefined, (old) => {
    if (!old) return { items: [{
      id: 'temp-' + Date.now(),
      name: newTag.name,
      color: newTag.color,
      feedCount: 0,
      unreadCount: 0,
      createdAt: new Date()
    }] };
    return { items: [...old.items, { /* temp tag */ }] };
  });

  return { previousData };
},
onSuccess: (data) => {
  // Replace temp tag with real one
  utils.tags.list.setData(undefined, (old) => {
    if (!old) return old;
    return {
      items: old.items.map(t =>
        t.id.startsWith('temp-') ? data.tag : t
      )
    };
  });
}
```

#### tags.update

**Current:** Invalidates `tags.list` (src/components/tags/TagManagementDialog.tsx:122)

**Efficient Approach:**

```typescript
onMutate: async (variables) => {
  await utils.tags.list.cancel();
  const previousData = utils.tags.list.getData();

  utils.tags.list.setData(undefined, (old) => {
    if (!old) return old;
    return {
      items: old.items.map(t =>
        t.id === variables.id
          ? { ...t, name: variables.name ?? t.name, color: variables.color ?? t.color }
          : t
      )
    };
  });

  return { previousData };
},
onError: (err, variables, context) => {
  if (context?.previousData) {
    utils.tags.list.setData(undefined, context.previousData);
  }
}
```

#### tags.delete

**Current:** Invalidates both `tags.list` AND `subscriptions.list` (src/components/tags/TagManagementDialog.tsx:165-166)

**Efficient Approach:**

```typescript
onMutate: async (variables) => {
  await Promise.all([utils.tags.list.cancel(), utils.subscriptions.list.cancel()]);

  const previousTags = utils.tags.list.getData();
  const previousSubscriptions = utils.subscriptions.list.getData();

  // Remove tag from tags list
  utils.tags.list.setData(undefined, (old) => {
    if (!old) return old;
    return { items: old.items.filter((t) => t.id !== variables.id) };
  });

  // Remove tag from all subscriptions
  utils.subscriptions.list.setData(undefined, (old) => {
    if (!old) return old;
    return {
      items: old.items.map((item) => ({
        ...item,
        subscription: {
          ...item.subscription,
          tags: item.subscription.tags.filter((t) => t.id !== variables.id),
        },
      })),
    };
  });

  return { previousTags, previousSubscriptions };
};
```

#### subscriptions.setTags

**Current:** Invalidates `tags.list` and `subscriptions.list` (src/components/feeds/EditSubscriptionDialog.tsx:75-77)

**Problem:** Server returns updated subscription but not updated tag feedCounts.

**Efficient Approach:**

```typescript
onMutate: async (variables) => {
  // Could update subscription.tags optimistically
  // But tag feedCounts require knowing all other subscriptions
  // API limitation: need server to return updated tag counts
};
```

**API Change Needed:** Server should return `{ subscription, affectedTags: Array<{ id, feedCount, unreadCount }> }`

**Impact:** Eliminates 2 full refetches per tag operation (4 mutations × average usage).

---

### High Priority: SSE Event Optimization

#### 1. new_entry Event - Invalidates Entire List

**Location:** src/lib/hooks/useRealtimeUpdates.ts:384-404

**Current Implementation:**

```typescript
if (data.type === "new_entry") {
  utils.entries.list.invalidate(); // Full refetch!

  // Does correctly update subscription unreadCount:
  utils.subscriptions.list.setData(undefined, (old) => {
    // Increment unread count for this feed
  });
}
```

**Problem:** A new entry in Feed A triggers a full refetch even if user is viewing Feed B.

**Efficient Approach:**

```typescript
if (data.type === "new_entry") {
  // Option 1: Fetch just the new entry and insert it
  const newEntry = await utils.entries.get.fetch({ id: data.entryId });
  utils.entries.list.setInfiniteData({ feedId: data.feedId }, (old) => {
    if (!old) return old;
    return {
      ...old,
      pages: old.pages.map((page, i) =>
        i === 0 ? { ...page, items: [newEntry, ...page.items] } : page
      ),
    };
  });

  // Option 2: Filter-aware invalidation (only if viewing this feed)
  utils.entries.list.invalidate({ feedId: data.feedId });
}
```

**Trade-off:** Option 1 requires an extra fetch but is more precise. Option 2 is simpler but still invalidates.

**Recommended:** Option 2 (filter-aware invalidation) - much simpler, still avoids refetching unrelated feeds.

#### 2. subscription_created Event - Full Refetch

**Location:** src/lib/hooks/useRealtimeUpdates.ts:408-417

**Current Implementation:**

```typescript
if (data.type === "subscription_created") {
  const existing = utils.subscriptions.list.getData();
  const alreadyInCache = existing?.items.some(
    (item) => item.subscription.id === data.subscriptionId
  );

  if (!alreadyInCache) {
    utils.subscriptions.list.invalidate(); // Full refetch of 100+ subscriptions!
    utils.entries.list.invalidate();
  }
}
```

**Problem:** For a user with 100 subscriptions, adding 1 more refetches all 100.

**Efficient Approach:**

```typescript
// Enhanced SSE payload (server-side change):
{
  type: "subscription_created",
  subscription: {
    id: string,
    feedId: string,
    customTitle: string | null,
    unreadCount: number,
    subscribedAt: Date,
    tags: Array<{ id: string, name: string, color: string | null }>
  },
  feed: {
    id: string,
    title: string | null,
    type: "web" | "email" | "saved",
    url: string | null,
    siteUrl: string | null,
    description: string | null
  }
}

// Client-side handling:
if (data.type === "subscription_created") {
  // Insert subscription into cache
  utils.subscriptions.list.setData(undefined, (old) => {
    if (!old) return { items: [{ subscription: data.subscription, feed: data.feed }] };
    return {
      items: [...old.items, { subscription: data.subscription, feed: data.feed }]
    };
  });

  // Update tags cache
  utils.tags.list.setData(undefined, (old) => {
    if (!old) return old;

    const updatedTags = [...old.items];
    data.subscription.tags.forEach(eventTag => {
      const existingIndex = updatedTags.findIndex(t => t.id === eventTag.id);

      if (existingIndex >= 0) {
        // Increment feedCount and unreadCount
        updatedTags[existingIndex] = {
          ...updatedTags[existingIndex],
          feedCount: updatedTags[existingIndex].feedCount + 1,
          unreadCount: updatedTags[existingIndex].unreadCount + data.subscription.unreadCount
        };
      } else {
        // New tag: add it
        updatedTags.push({
          id: eventTag.id,
          name: eventTag.name,
          color: eventTag.color,
          feedCount: 1,
          unreadCount: data.subscription.unreadCount,
          createdAt: new Date()
        });
      }
    });

    return { items: updatedTags };
  });

  // No invalidation needed!
}
```

**Impact:**

- Current: ~50-100 KB refetch for 100 subscriptions
- Optimized: 0 KB (fully optimistic update)

**Special Case - OPML Import:**
During import of 50 feeds, this optimization means:

- Current: 50 SSE events ignored, 1 massive refetch at end
- Optimized: 50 SSE events each insert 1 subscription, sidebar updates in real-time

---

### Medium Priority: Settings Mutations

All of these mutations use invalidation when optimistic updates would work:

#### subscriptions.update (Custom Title)

**Location:** src/components/feeds/EditSubscriptionDialog.tsx:113-145

**Current:** Relies on component remount to refetch, no explicit cache update

**Fix:** Add optimistic update targeting just `customTitle` field

#### ingestAddresses.create/update/delete

**Location:** src/app/(app)/settings/email/page.tsx

**Current:** All invalidate `ingestAddresses.list` (lines 72, 203, 214)

**Fix:** Add optimistic updates (create with placeholder, update/delete with immediate cache mutation)

#### blockedSenders.unblock

**Location:** src/app/(app)/settings/blocked-senders/page.tsx:148-157

**Current:** Invalidates `blockedSenders.list` (line 151)

**Fix:** Optimistically remove from list

#### brokenFeeds.retryFetch

**Location:** src/app/(app)/settings/broken-feeds/page.tsx:237-251

**Current:** Invalidates `brokenFeeds.list` (line 242)

**Fix:** Optimistically update `consecutiveFailures` and `lastError` fields

**Impact:** Eliminates 1 query per operation across 6 mutations.

---

### Medium Priority: Auth Session Management

#### auth.unlinkProvider

**Location:** src/app/(app)/settings/account/page.tsx:126-139

**Current:** Invalidates `users.me.get` (line 130)

**Fix:** Use `setData` to remove the provider from linkedAccounts array

#### users.me.revokeSession

**Location:** src/app/(app)/settings/sessions/page.tsx:99-107

**Current:** Invalidates `users.me.listSessions` (line 102)

**Fix:** Optimistically remove session from list

**Impact:** Eliminates 1 query per operation.

---

### Low Priority: Minor Fixes

#### Saved Article Filter Bug

**Location:** src/lib/hooks/useSavedArticleMutations.ts

**Problem:** When marking saved article as read with `unreadOnly: true` filter active, the entry isn't removed from the list (unlike `useEntryMutations` which handles this correctly).

**Fix:** Copy the filter-aware cache update logic from `useEntryMutations.ts:108-142`.

#### entries.markRead - Unnecessary starredCount Invalidation

**Location:** src/lib/hooks/useEntryMutations.ts:108-142

**Problem:** Always invalidates `entries.starredCount` even when marking an unstarred entry as read.

**Fix:** Only invalidate if the entry is actually starred:

```typescript
if (result.starred) {
  utils.entries.starredCount.invalidate();
}
```

**Impact:** Minor - eliminates 1 unnecessary query on common operation.

---

## Already Well-Optimized

These mutations serve as examples of good patterns:

### entries.markRead

- ✅ Optimistic updates to entries.list using `setInfiniteData`
- ✅ Targeted updates to subscription unreadCount
- ✅ Server returns `feedUnreadCounts` for efficient cache updates
- ❌ Minor issue: unnecessary starredCount invalidation

### subscriptions.create

- ✅ Optimistic insertion into subscriptions.list
- ✅ Server publishes SSE event for multi-device sync
- ✅ Smart coordination between mutation and SSE event (checks if already in cache)

### users.me.updatePreferences

- ✅ Gold standard optimistic update pattern
- ✅ Cancel in-flight queries in onMutate
- ✅ Snapshot for rollback
- ✅ Immediate cache update with setData
- ✅ Proper error handling with rollback

### subscriptions.import (OPML)

- ✅ Background job queue
- ✅ SSE progress events without invalidating subscriptions on each feed
- ✅ Bulk invalidation only at completion
- ✅ Polling fallback for SSE unavailability

---

## Proposed Solutions Summary

### API Changes Required

1. **entries.markAllRead** - Return `feedUnreadCounts: Record<feedId, number>`
2. **entries.star/unstar** - Return full entry object (not just `{id, read, starred}`)
3. **subscriptions.setTags** - Return `affectedTags: Array<{ id, feedCount, unreadCount }>`
4. **SSE subscription_created** - Include full subscription + feed data in event payload

### Client-Side Changes

All changes involve adding or improving `onMutate`, `onSuccess`, and `onError` callbacks to mutations:

| File                                            | Mutations to Fix                          | LOC Estimate |
| ----------------------------------------------- | ----------------------------------------- | ------------ |
| src/app/(app)/settings/account/page.tsx         | auth.link\*, auth.unlink                  | 40           |
| src/lib/hooks/useEntryMutations.ts              | markAllRead optimization, star/unstar fix | 60           |
| src/components/tags/TagManagementDialog.tsx     | create, update, delete                    | 120          |
| src/components/feeds/EditSubscriptionDialog.tsx | update, setTags                           | 80           |
| src/app/(app)/settings/email/page.tsx           | ingestAddresses.\*                        | 60           |
| src/app/(app)/settings/blocked-senders/page.tsx | unblock                                   | 20           |
| src/app/(app)/settings/broken-feeds/page.tsx    | retryFetch                                | 20           |
| src/app/(app)/settings/sessions/page.tsx        | revokeSession                             | 20           |
| src/lib/hooks/useRealtimeUpdates.ts             | SSE events                                | 80           |
| src/lib/hooks/useSavedArticleMutations.ts       | Filter bug fix                            | 20           |

**Total estimated:** ~520 LOC changes

### Server-Side Changes

| File                                     | Change                                   | LOC Estimate |
| ---------------------------------------- | ---------------------------------------- | ------------ |
| src/server/trpc/routers/entries.ts       | markAllRead return feedUnreadCounts      | 20           |
| src/server/trpc/routers/subscriptions.ts | setTags return affectedTags              | 30           |
| src/server/redis/pubsub.ts               | subscription_created payload enhancement | 40           |

**Total estimated:** ~90 LOC changes

---

## Implementation Plan

### Phase 1: Critical Fixes (1-2 hours)

1. ✅ Fix `auth.linkGoogle/linkApple` cache bug
2. ✅ Fix `auth.unlinkProvider` to use optimistic update
3. ✅ Fix saved article filter bug

**Impact:** Fix broken features, improve UX

### Phase 2: High-Impact Optimizations (4-6 hours)

1. ✅ Optimize `entries.markAllRead` (requires API change)
2. ✅ Fix `entries.star/unstar` unnecessary invalidations
3. ✅ Add optimistic updates to all tag mutations
4. ✅ Optimize `subscription_created` SSE event (requires API change)

**Impact:** Eliminate 10-15 unnecessary queries per user session

### Phase 3: Settings Optimizations (2-3 hours)

1. ✅ Add optimistic updates to subscription.update
2. ✅ Add optimistic updates to ingestAddresses.\*
3. ✅ Add optimistic updates to blockedSenders.unblock
4. ✅ Add optimistic updates to brokenFeeds.retryFetch

**Impact:** Eliminate 4-6 queries per settings interaction

### Phase 4: Polish (1 hour)

1. ✅ Fix `entries.markRead` starredCount invalidation
2. ✅ Add optimistic update to `users.me.revokeSession`

**Impact:** Minor performance improvements

---

## Trade-offs and Considerations

### Benefits

- **Reduced network traffic**: 15-20+ fewer queries per user session
- **Faster UI**: Immediate feedback via optimistic updates
- **Better UX**: No loading states for simple operations
- **Reduced server load**: Fewer full list queries

### Risks

- **Increased complexity**: More code in mutation callbacks
- **Cache inconsistency**: If optimistic updates have bugs, cache diverges from server
- **Testing burden**: Need to test optimistic updates with network delays and errors

### Mitigation Strategies

1. **Always include error rollback logic** in `onError` callbacks
2. **Use TypeScript strictly** - no `any` types in cache update logic
3. **Test with network throttling** to simulate slow connections
4. **Add integration tests** for critical mutations
5. **Monitor error rates** after deployment to catch cache inconsistencies
6. **Keep invalidation as fallback** - if optimistic update fails, fall back to invalidation

### When to Use Optimistic Updates

**Good candidates:**

- ✅ Simple field updates (customTitle, label, name, color)
- ✅ List additions/removals (create, delete, unsubscribe)
- ✅ Boolean toggles (read/unread, starred/unstarred)
- ✅ Operations where we know exact server response

**Poor candidates:**

- ❌ Operations with complex server-side calculations
- ❌ Operations with unpredictable side effects
- ❌ Bulk operations affecting many entities
- ❌ Operations where client doesn't have enough context

---

## Testing Plan

### Unit Tests

- Test cache update logic in isolation
- Test rollback on error
- Test edge cases (empty lists, missing data)

### Integration Tests

- Test full mutation flow with real API
- Test with network delays (throttle to 3G)
- Test error scenarios (server errors, network failures)
- Test SSE event handling with optimistic updates

### Manual Testing Checklist

- [ ] Subscribe to feed → sidebar updates immediately
- [ ] Mark all as read → counts update without flash
- [ ] Create tag → appears immediately in tag list
- [ ] Link OAuth account → appears in settings immediately
- [ ] OPML import → sidebar updates in real-time during import
- [ ] Test on slow connection (3G throttling)
- [ ] Test error rollback (disconnect network mid-operation)

---

## Metrics to Track

**Before vs After:**

1. Network request count per user session
2. Time to interactive (TTI) for common operations
3. Cache hit rate
4. Error rate in mutation callbacks
5. User-reported bugs related to stale data

**Success Criteria:**

- 50% reduction in network requests for common workflows
- <100ms perceived latency for optimistic operations
- <1% increase in error rate
- Zero increase in stale data bugs

---

## Future Enhancements

1. **Normalization layer**: Use a library like RTK Query or custom normalization to avoid cache duplication
2. **Optimistic SSE**: Apply SSE events optimistically before server confirms
3. **Offline support**: Queue mutations when offline, apply optimistically
4. **Cache persistence**: Persist React Query cache to localStorage for instant page loads

---

## References

- [React Query Optimistic Updates Docs](https://tanstack.com/query/latest/docs/framework/react/guides/optimistic-updates)
- [tRPC with React Query](https://trpc.io/docs/client/react/useContext#helpers)
- Existing well-optimized mutations: `entries.markRead`, `subscriptions.create`, `users.me.updatePreferences`

---

## Appendix: Complete Mutation Inventory

### tRPC Mutations (34)

**Subscriptions (5):**

- create ✅ - Already optimized
- update ⚠️ - Needs optimistic update
- delete ✅ - Already optimized (uses onMutate in Sidebar)
- import ✅ - Already optimized
- setTags ⚠️ - Needs API change + optimistic update

**Entries (4):**

- markRead ✅ - Already optimized (minor fix needed)
- markAllRead ⚠️ - Needs API change + optimistic update
- star ⚠️ - Needs fix (remove unnecessary invalidation)
- unstar ⚠️ - Needs fix (remove unnecessary invalidation)

**Auth (8):**

- register ✅ - No cache to update
- login ✅ - No cache to update
- logout ✅ - Clears all cache appropriately
- googleCallback ✅ - No cache to update (redirect)
- appleCallback ✅ - No cache to update (redirect)
- linkGoogle ❌ - BUG: Doesn't update cache
- linkApple ❌ - BUG: Doesn't update cache
- unlinkProvider ⚠️ - Should use optimistic update
- requestGoogleDocsAccess ✅ - No cache to update (just returns URL)

**Tags (3):**

- create ⚠️ - Needs optimistic update
- update ⚠️ - Needs optimistic update
- delete ⚠️ - Needs optimistic update

**Users (3):**

- me.get ✅ - Query, not mutation
- me.changePassword ✅ - No cache to update
- me.updatePreferences ✅ - Gold standard optimistic update
- me.revokeSession ⚠️ - Should use optimistic update

**Saved Articles (2):**

- save ✅ - Invalidates appropriately
- delete ✅ - Has optimistic update (minor bug in filter handling)

**Ingest Addresses (3):**

- create ⚠️ - Needs optimistic update
- update ⚠️ - Needs optimistic update
- delete ⚠️ - Needs optimistic update

**Blocked Senders (1):**

- unblock ⚠️ - Needs optimistic update

**Broken Feeds (1):**

- retryFetch ⚠️ - Needs optimistic update

**Narration (1):**

- generate ✅ - Already optimal (read-only mutation)

**Admin (2):**

- createInvite ✅ - Low priority (admin only)
- revokeInvite ✅ - Low priority (admin only)

### SSE Events (8)

- new_entry ⚠️ - Should use filter-aware invalidation
- entry_updated ✅ - Already targeted
- subscription_created ⚠️ - Needs enhanced payload + optimistic update
- subscription_deleted ✅ - Already optimized
- saved_article_created ✅ - Already targeted
- saved_article_updated ✅ - Already targeted
- import_progress ✅ - Already optimized
- import_completed ✅ - Already optimized

**Legend:**

- ✅ Already optimal or appropriate for use case
- ⚠️ Has optimization opportunities
- ❌ Critical bug/issue

---

## Conclusion

This audit identified significant opportunities to improve Lion Reader's cache management through optimistic updates and targeted cache mutations. The proposed changes would eliminate 15-20+ unnecessary network requests per user session while improving perceived performance through immediate UI feedback.

Implementation can be done incrementally, starting with critical bug fixes and high-impact optimizations, then moving to polish and edge cases. The patterns established in already-optimized mutations (`entries.markRead`, `subscriptions.create`, `users.me.updatePreferences`) should serve as templates for the improvements.
