/**
 * Cache Update Helpers
 *
 * Centralized functions for updating React Query cache directly.
 * These helpers ensure consistency across all affected caches when
 * modifying entries, subscriptions, or counts.
 *
 * Design principles:
 * - Server returns context needed for updates (subscriptionId, etc.)
 * - Helpers update ALL affected caches (entry lists, counts, subscriptions, tags)
 * - Avoid full refetches when we have enough info to update directly
 */

export {
  updateEntriesReadStatus,
  updateEntryStarredStatus,
  removeEntryFromStarredLists,
  type EntryReadUpdate,
} from "./entry-cache";

export {
  adjustSubscriptionUnreadCounts,
  adjustTagUnreadCounts,
  adjustEntriesCount,
  addSubscriptionToCache,
  removeSubscriptionFromCache,
  calculateTagDeltasFromSubscriptions,
} from "./count-cache";
