/**
 * Cache Update Helpers
 *
 * Centralized functions for updating React Query cache directly.
 *
 * ## Usage
 *
 * Use the high-level operations for mutations and SSE handlers:
 * - `handleEntriesMarkedRead` - When entries are marked read/unread
 * - `handleEntryStarred` / `handleEntryUnstarred` - When entries are starred/unstarred
 * - `handleSubscriptionCreated` / `handleSubscriptionDeleted` - For subscription changes
 * - `handleNewEntry` - When a new entry is created (from SSE events)
 *
 * These operations handle all the cache interactions correctly (e.g., starring
 * an unread entry updates the starred unread count).
 *
 * Low-level helpers are also exported for special cases but prefer the operations.
 */

// High-level operations (primary API)
export {
  handleEntriesMarkedRead,
  handleEntryStarred,
  handleEntryUnstarred,
  handleEntryScoreChanged,
  handleSubscriptionCreated,
  handleSubscriptionDeleted,
  handleNewEntry,
  setCounts,
  setBulkCounts,
  type EntryWithContext,
  type SubscriptionData,
  type UnreadCounts,
  type BulkUnreadCounts,
} from "./operations";

// Low-level helpers (for special cases)
export {
  updateEntriesReadStatus,
  updateEntryStarredStatus,
  updateEntryScoreInCache,
  updateEntriesInListCache,
} from "./entry-cache";

export {
  adjustSubscriptionUnreadCounts,
  adjustTagUnreadCounts,
  adjustEntriesCount,
  addSubscriptionToCache,
  removeSubscriptionFromCache,
  calculateTagDeltasFromSubscriptions,
  findCachedSubscription,
} from "./count-cache";
