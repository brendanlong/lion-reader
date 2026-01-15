# Zustand Delta Architecture - Behavior Checklist

This document ensures all mutation scenarios are handled consistently across all views.

## Views

- **Feed View**: Viewing entries from a specific subscription
- **Tag View**: Viewing entries from all subscriptions with a tag
- **Uncategorized View**: Viewing entries from subscriptions with no tags
- **All View**: Viewing all entries
- **Starred View**: Viewing only starred entries (`starredOnly: true`)
- **Unread View**: Any view with "Unread only" filter enabled (`unreadOnly: true`)

## Mutations

### 1. Mark Entry as Read

#### Expected Behavior (All Views)

- ✅ Entry shows as read instantly (optimistic)
- ✅ Feed unread count decrements
- ✅ All tag unread counts decrement (for tags on the feed)
- ✅ "Uncategorized" unread count decrements (if feed has no tags)
- ✅ Starred unread count updates (if entry is starred)
- ✅ Entry disappears from list if `unreadOnly: true`

#### Implementation

- **Zustand**: `markRead(entryId, subscriptionId, tagIds)`
- **Count Tracking**: Updates `subscriptionCountDeltas` and `tagCountDeltas`
- **Filtering**: EntryList filters out read entries when `unreadOnly: true`
- **Starred Count**: Invalidates `entries.count({ starredOnly: true })` on success

### 2. Mark Entry as Unread

#### Expected Behavior (All Views)

- ✅ Entry shows as unread instantly (optimistic)
- ✅ Feed unread count increments
- ✅ All tag unread counts increment (for tags on the feed)
- ✅ "Uncategorized" unread count increments (if feed has no tags)
- ✅ Starred unread count updates (if entry is starred)
- ✅ Entry appears in unread-only views

#### Implementation

- **Zustand**: `markUnread(entryId, subscriptionId, tagIds)`
- **Count Tracking**: Updates `subscriptionCountDeltas` and `tagCountDeltas`
- **Filtering**: No filtering needed (unread entries show in all views)
- **Starred Count**: Invalidates `entries.count({ starredOnly: true })` on success

### 3. Star Entry

#### Expected Behavior (All Views)

- ✅ Entry shows as starred instantly (optimistic)
- ✅ Entry appears in Starred view
- ✅ Starred total count increments
- ✅ Starred unread count increments (if entry is unread)

#### Implementation

- **Zustand**: `toggleStar(entryId, false)`
- **Count Tracking**: No subscription/tag counts affected
- **Filtering**: No filtering needed (starred entries show in all views)
- **Starred List**: Invalidates `entries.list({ starredOnly: true })` in onSettled

### 4. Unstar Entry

#### Expected Behavior (All Views)

- ✅ Entry shows as unstarred instantly (optimistic)
- ✅ Entry disappears from Starred view
- ✅ Starred total count decrements
- ✅ Starred unread count decrements (if entry is unread)

#### Implementation

- **Zustand**: `toggleStar(entryId, true)`
- **Count Tracking**: No subscription/tag counts affected
- **Filtering**: EntryList filters out unstarred entries when `starredOnly: true`
- **Starred List**: Invalidates `entries.list({ starredOnly: true })` in onSettled

## Count Delta Sources

### Subscription Count Deltas

Updated by:

- ✅ `markRead` / `markUnread` (manual mutations)
- ✅ `onNewEntry` (SSE/polling - new entry arrives)
- ✅ `onSubscriptionCreated` (SSE - new subscription added)

### Tag Count Deltas

Updated by:

- ✅ `markRead` / `markUnread` (manual mutations with tagIds)
- ✅ `onSubscriptionCreated` (SSE - subscription with tags added)
- ✅ `onSubscriptionDeleted` (SSE - subscription with tags removed)

### Starred Count

- **NOT tracked in Zustand** - invalidated instead
- Refetch via `entries.count.invalidate({ starredOnly: true })`

## Edge Cases

### Entry Not in Cache

**Scenario**: Marking an entry read/unread when it's not in the current list cache (e.g., from search results or detail view)

**Behavior**:

- Zustand lookup fails to find subscriptionId from cache
- Falls back to just tracking read state without count updates
- Counts will update on next SSE event or page refetch

**Status**: ✅ Handled (graceful degradation)

### Multiple Tags on One Feed

**Scenario**: Feed has tags ["Tech", "News"], marking entry read should decrement both

**Behavior**:

- Look up subscription to get all tagIds
- Update all tag count deltas simultaneously
- All tag counts update correctly

**Status**: ✅ Handled

### Tag View with Subscription Not in Cache

**Scenario**: Viewing a tag, marking an entry read, but subscriptions list not loaded

**Behavior**:

- Entry lookup finds subscriptionId from entries cache
- Subscription lookup fails (subscriptionsData is undefined)
- tagIds is undefined, so only subscription count updates
- Tag count will update on next SSE event or refetch

**Status**: ✅ Handled (graceful degradation)

### Starred Entry with No Subscription

**Scenario**: Entry is starred, but its subscription was deleted

**Behavior**:

- Entry is "visible" due to starred status (per visibility rules)
- Marking read/unread: subscriptionId lookup fails
- Falls back to just tracking read state
- Starred count still updates (via invalidation)

**Status**: ✅ Handled

## Reset Scenarios

### Full Reset (Error Recovery)

**Trigger**: Mutation error, SSE reconnection gap
**Action**: `useRealtimeStore.getState().reset()`
**Effect**: All deltas cleared, queries invalidated, fresh data fetched

### Partial Reset (Navigation)

**Trigger**: User navigates to new page (optional)
**Action**: None currently - deltas persist across navigation
**Effect**: Old deltas might show stale data briefly until refetch

**Consideration**: We could add `reset()` on route change if this becomes an issue

## Testing Matrix

| View                  | Action      | Feed Count   | Tag Count        | Starred Count | Entry Visible |
| --------------------- | ----------- | ------------ | ---------------- | ------------- | ------------- |
| Feed                  | Mark Read   | ✅ -1        | ✅ -1 (all tags) | ✅ Update     | ✅ Stays      |
| Feed (Unread Only)    | Mark Read   | ✅ -1        | ✅ -1 (all tags) | ✅ Update     | ✅ Disappears |
| Tag                   | Mark Read   | ✅ -1        | ✅ -1 (all tags) | ✅ Update     | ✅ Stays      |
| Tag (Unread Only)     | Mark Read   | ✅ -1        | ✅ -1 (all tags) | ✅ Update     | ✅ Disappears |
| Uncategorized         | Mark Read   | ✅ -1        | N/A              | ✅ Update     | ✅ Stays      |
| All                   | Mark Read   | ✅ -1        | ✅ -1 (all tags) | ✅ Update     | ✅ Stays      |
| Starred               | Mark Read   | ✅ -1        | ✅ -1 (all tags) | ✅ Update     | ✅ Stays      |
| Starred (Unread Only) | Mark Read   | ✅ -1        | ✅ -1 (all tags) | ✅ Update     | ✅ Disappears |
| Feed                  | Mark Unread | ✅ +1        | ✅ +1 (all tags) | ✅ Update     | ✅ Stays      |
| Feed                  | Star        | ✅ No change | ✅ No change     | ✅ +1         | ✅ Stays      |
| All                   | Star        | ✅ No change | ✅ No change     | ✅ +1         | ✅ Stays      |
| Starred               | Unstar      | ✅ No change | ✅ No change     | ✅ -1         | ✅ Disappears |
| Feed                  | Unstar      | ✅ No change | ✅ No change     | ✅ -1         | ✅ Stays      |

## Known Limitations

1. **Starred Count Not in Zustand**: We invalidate instead of tracking deltas
   - Reason: Simpler implementation, starred count is less frequently accessed
   - Trade-off: Extra query on each mark read/unread of starred entries

2. **SSE Event Ordering**: Events might arrive out of order
   - Mitigation: Idempotent operations (Sets prevent duplicates)
   - Edge case: Mark read → SSE mark read event arrives → no issue (idempotent)

3. **Tag IDs Lookup**: Requires subscriptions data in cache
   - Fallback: Just update subscription count if tags unavailable
   - Recovery: Next SSE event or refetch will sync counts

## Future Improvements

1. **Starred Count Tracking**: Add to Zustand to avoid invalidation
2. **Reset on Navigation**: Optionally clear deltas when navigating between views
3. **Delta Expiry**: Clear old deltas after N minutes to prevent memory growth
4. **Test Coverage**: Add integration tests for all scenarios in the matrix above
