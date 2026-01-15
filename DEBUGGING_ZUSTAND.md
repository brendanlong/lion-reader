# Debugging Zustand Delta State

This guide shows you how to monitor Zustand state changes to debug issues with optimistic updates and count deltas.

## Method 1: Visual Debug Component (Recommended for Quick Checks)

Add the `ZustandDebug` component to any page to see live state updates:

```tsx
import { ZustandDebug } from "@/components/debug/ZustandDebug";

export default function SomePage() {
  return (
    <>
      {/* Your page content */}
      <ZustandDebug />
    </>
  );
}
```

The debug panel shows:

- **Read IDs**: Entries marked as read (optimistic)
- **Unread IDs**: Entries marked as unread (optimistic)
- **Starred IDs**: Entries starred (optimistic)
- **Unstarred IDs**: Entries unstarred (optimistic)
- **Subscription Count Deltas**: Per-feed unread count adjustments (+/-)
- **Tag Count Deltas**: Per-tag unread count adjustments (+/-)
- **New Entry IDs**: Entries received via SSE
- **Pending Entries**: SSE entries not yet in server state

### Quick Add to Layout

To enable debugging globally during development:

```tsx
// src/app/(app)/layout.tsx
import { ZustandDebug } from "@/components/debug/ZustandDebug";

export default function AppLayout({ children }) {
  return (
    <>
      {children}
      {process.env.NODE_ENV === "development" && <ZustandDebug />}
    </>
  );
}
```

## Method 2: Browser Console (Detailed Logging)

In development mode, Zustand logs all state changes to the console:

### Console Output Format

```
📖 markRead: { entryId: "abc123", subscriptionId: "sub456", tagIds: ["tag1", "tag2"] }
📕 markUnread: { entryId: "abc123", subscriptionId: "sub456", tagIds: ["tag1", "tag2"] }
⭐ star: { entryId: "abc123" }
☆ unstar: { entryId: "abc123" }
⏭️  markRead: already read { entryId: "abc123" }
↩️  toggleStar: undoing previous star { entryId: "abc123" }
```

### How to Use Console Logging

1. Open DevTools (F12)
2. Go to Console tab
3. Perform an action (mark read, star, etc.)
4. Look for emoji-prefixed log messages
5. Check if the action was called with the correct parameters

### Common Issues to Look For

**Problem: Action logged but no counts update**

```
📖 markRead: { entryId: "abc123", subscriptionId: undefined, tagIds: undefined }
```

→ subscriptionId lookup failed, counts won't update

**Problem: Action skipped as idempotent**

```
⏭️  markRead: already read { entryId: "abc123" }
```

→ Entry already in readIds Set, check why it's being called again

**Problem: Undoing previous action**

```
↩️  toggleStar: undoing previous star { entryId: "abc123" }
```

→ Cancelling out a previous optimistic update

## Method 3: Redux DevTools (Most Detailed)

Zustand integrates with Redux DevTools for time-travel debugging.

### Setup

1. Install [Redux DevTools Extension](https://chromewebstore.google.com/detail/redux-devtools/lmhkpmbekcpmknklioeibfkpmmfibljd)
2. Open DevTools (F12)
3. Click "Redux" tab
4. Select "RealtimeStore" from dropdown

### Features

- **Action History**: See every state change with before/after snapshots
- **Time Travel**: Jump back to any previous state
- **State Inspector**: Drill into nested state objects
- **Diff Viewer**: See exactly what changed in each action
- **Charts**: Visualize state changes over time

### Example Debugging Session

1. Mark an entry as read
2. Check Redux DevTools → Actions
3. Find the SET action
4. View State Diff to see what changed:
   - readIds: +1 entry
   - subscriptionCountDeltas: {"sub456": -1}
   - tagCountDeltas: {"tag1": -1, "tag2": -1}

## Common Debugging Scenarios

### Scenario 1: Counts Not Updating

**Symptoms**: Mark entry read, but sidebar counts don't change

**Debug Steps**:

1. Check console for markRead log
2. Verify subscriptionId and tagIds are present
3. Check ZustandDebug panel:
   - Is readIds updated? → If yes, state is correct
   - Are subscriptionCountDeltas showing? → If no, lookup failed
   - Are tagCountDeltas showing? → If no, tagIds not found
4. Check Sidebar component: Is it using `useRealtimeStore` selectors?

**Common Causes**:

- Entry not in cache, so subscriptionId lookup fails
- Subscriptions list not loaded, so tags lookup fails
- Sidebar not subscribed to delta state

### Scenario 2: Entry Visible After Filtering

**Symptoms**: Unstar entry, but it stays in Starred view

**Debug Steps**:

1. Check console for unstar log
2. Check ZustandDebug: Is unstarredIds updated?
3. Check EntryList component: Does it filter after applying deltas?
4. Look for this code:
   ```tsx
   .filter((entry) => {
     if (filters?.starredOnly && !entry.starred) return false;
     return true;
   })
   ```

**Common Causes**:

- Filtering happens before delta merge (wrong order)
- Filter check missing for the view type
- Entry starred state not being merged from Zustand

### Scenario 3: Mutation Called But No Zustand Update

**Symptoms**: Click mark read, console shows mutation, but no Zustand log

**Debug Steps**:

1. Check mutation onMutate handler
2. Verify it's calling `useRealtimeStore.getState().markRead(...)`
3. Add breakpoint or console.log before the call
4. Check if subscriptionId is being passed

**Common Causes**:

- Mutation doesn't call Zustand at all
- Early return due to missing listFilters
- Exception thrown before Zustand call

### Scenario 4: Counts Drift Over Time

**Symptoms**: After several actions, counts become incorrect

**Debug Steps**:

1. Open Redux DevTools
2. Review action history
3. Look for duplicate actions or missing actions
4. Check if SSE events are duplicating mutations
5. Verify idempotency checks are working (⏭️ logs)

**Common Causes**:

- SSE event arrives after manual mutation (should be idempotent)
- Reset not called after error
- Server and client out of sync (needs full refetch)

## Disabling Debug Logging

Debug logging only runs in development mode. In production:

- Console logs are automatically disabled
- Redux DevTools integration remains (but won't collect data without the extension)
- ZustandDebug component can be conditionally rendered

To fully disable in development, edit `src/lib/store/realtime.ts`:

```typescript
const DEBUG = false; // Change to false
```

## Performance Impact

- **Console Logging**: Minimal (~1ms per action)
- **Redux DevTools**: Slight overhead when recording (~5-10ms per action)
- **ZustandDebug Component**: Re-renders on every state change (disable when not actively debugging)

## Next Steps

If you find issues:

1. Document the sequence of actions that cause the problem
2. Include console logs and Redux DevTools screenshots
3. Check if the behavior matches ZUSTAND_DELTA_CHECKLIST.md
4. File an issue or discuss with the team
