/**
 * Google Reader API Response Formatting
 *
 * Transforms Lion Reader service data into the JSON format expected
 * by Google Reader clients.
 */

import { uuidToInt64, int64ToLongFormId, subscriptionToStreamId, feedStreamId } from "./id";
import { stateStreamId, labelStreamId } from "./streams";
import { SAVED_FEED_TITLE } from "@/server/feed/saved-feed";
import type { EntryFull } from "@/server/services/entries";
import type { Subscription } from "@/server/services/subscriptions";
import type { ListTagsResult } from "@/server/services/tags";

// ============================================================================
// Item (Entry) Formatting
// ============================================================================

interface GoogleReaderItem {
  id: string;
  crawlTimeMsec: string;
  timestampUsec: string;
  published: number;
  updated: number;
  title: string;
  canonical: Array<{ href: string }>;
  alternate: Array<{ href: string; type: string }>;
  summary: { direction: string; content: string };
  author: string;
  origin: {
    streamId: string;
    title: string;
    htmlUrl: string;
  };
  categories: string[];
}

/**
 * Formats a full entry (with content) as a Google Reader item.
 */
export function formatEntryAsItem(entry: EntryFull): GoogleReaderItem {
  const itemId = uuidToInt64(entry.id);
  const publishedTs = entry.publishedAt
    ? Math.floor(entry.publishedAt.getTime() / 1000)
    : Math.floor(entry.fetchedAt.getTime() / 1000);
  const updatedTs = Math.floor(entry.updatedAt.getTime() / 1000);
  const crawlTimeMs = entry.fetchedAt.getTime().toString();

  const categories: string[] = [];
  // All items are in the reading list
  categories.push(stateStreamId("reading-list"));
  if (entry.read) {
    categories.push(stateStreamId("read"));
  }
  if (entry.starred) {
    categories.push(stateStreamId("starred"));
  }

  // Build content from cleaned or original HTML
  const content = entry.contentCleaned ?? entry.contentOriginal ?? entry.summary ?? "";

  return {
    id: int64ToLongFormId(itemId),
    crawlTimeMsec: crawlTimeMs,
    timestampUsec: (BigInt(crawlTimeMs) * BigInt(1000)).toString(),
    published: publishedTs,
    updated: updatedTs,
    title: entry.title ?? "",
    canonical: entry.url ? [{ href: entry.url }] : [],
    alternate: entry.url ? [{ href: entry.url, type: "text/html" }] : [],
    summary: {
      direction: "ltr",
      content,
    },
    author: entry.author ?? "",
    origin: {
      // Saved articles have no subscription; address them by their saved-feed id
      // (exposed as the synthetic "Saved Articles" subscription — issue #730) so
      // clients attach them to a known feed instead of dropping an empty origin.
      streamId: originStreamId(entry),
      title: entry.feedTitle ?? "",
      htmlUrl: entry.feedUrl ?? entry.url ?? "",
    },
    categories,
  };
}

/**
 * The `origin.streamId` for an item. Regular entries use their subscription's
 * stream id; saved articles (no subscription) use their saved-feed id, matching
 * the synthetic subscription emitted by `formatSavedSubscription`.
 */
function originStreamId(entry: EntryFull): string {
  if (entry.subscriptionId) {
    return subscriptionToStreamId(entry.subscriptionId);
  }
  if (entry.type === "saved") {
    return feedStreamId(entry.feedId);
  }
  return "";
}

// ============================================================================
// Subscription Formatting
// ============================================================================

interface GoogleReaderSubscription {
  id: string;
  title: string;
  categories: Array<{ id: string; label: string }>;
  sortid: string;
  firstitemmsec: string;
  url: string;
  htmlUrl: string;
  iconUrl: string;
}

/**
 * Formats a subscription as a Google Reader subscription object.
 */
export function formatSubscription(sub: Subscription): GoogleReaderSubscription {
  const int64Id = uuidToInt64(sub.id);

  return {
    id: feedStreamId(sub.id),
    title: sub.title ?? "",
    categories: sub.tags.map((tag) => ({
      id: labelStreamId(tag.name),
      label: tag.name,
    })),
    sortid: int64Id.toString(16).padStart(16, "0"),
    firstitemmsec: sub.subscribedAt.getTime().toString(),
    url: sub.url ?? "",
    htmlUrl: sub.siteUrl ?? sub.url ?? "",
    iconUrl: "",
  };
}

/**
 * Formats the per-user saved-articles feed as a synthetic Google Reader
 * subscription (issue #730). Saved articles have no real subscription row, so
 * they are exposed as an uncategorized "Saved Articles" feed keyed by the saved
 * feed's own id. No categories (uncategorized) avoids the folder-name-uniqueness
 * edge cases a synthetic folder would introduce.
 */
export function formatSavedSubscription(savedFeedId: string): GoogleReaderSubscription {
  const int64Id = uuidToInt64(savedFeedId);

  return {
    id: feedStreamId(savedFeedId),
    title: SAVED_FEED_TITLE,
    categories: [],
    sortid: int64Id.toString(16).padStart(16, "0"),
    firstitemmsec: "0",
    url: "",
    htmlUrl: "",
    iconUrl: "",
  };
}

// ============================================================================
// Tag Formatting
// ============================================================================

interface GoogleReaderTag {
  id: string;
  sortid?: string;
  type?: string;
}

/**
 * Formats tags as Google Reader tag list.
 * Includes system tags (reading-list, starred) and user labels.
 */
export function formatTagList(tagsResult: ListTagsResult): GoogleReaderTag[] {
  const result: GoogleReaderTag[] = [];

  // System tags
  result.push({
    id: stateStreamId("reading-list"),
    sortid: "00000000",
  });
  result.push({
    id: stateStreamId("starred"),
    sortid: "00000001",
  });

  // User labels (tags)
  for (const tag of tagsResult.items) {
    result.push({
      id: labelStreamId(tag.name),
      sortid: uuidToInt64(tag.id).toString(16).padStart(16, "0"),
      type: "folder",
    });
  }

  return result;
}

// ============================================================================
// Unread Count Formatting
// ============================================================================

interface GoogleReaderUnreadCount {
  id: string;
  count: number;
  newestItemTimestampUsec: string;
}

/**
 * Formats unread counts per subscription for the Google Reader unread-count endpoint.
 *
 * `savedFeed`, when present, adds the synthetic "Saved Articles" feed (issue
 * #730) as its own line and folds its unread into the reading-list total —
 * keeping the total consistent with saved articles appearing in the reading-list
 * stream.
 */
export function formatUnreadCounts(
  subscriptions: Array<{ id: string; unreadCount: number; subscribedAt: Date }>,
  savedFeed?: { feedId: string; unreadCount: number }
): {
  max: number;
  unreadcounts: GoogleReaderUnreadCount[];
} {
  const unreadcounts: GoogleReaderUnreadCount[] = [];

  let totalUnread = 0;
  for (const sub of subscriptions) {
    if (sub.unreadCount > 0) {
      unreadcounts.push({
        id: feedStreamId(sub.id),
        count: sub.unreadCount,
        newestItemTimestampUsec: (sub.subscribedAt.getTime() * 1000).toString(),
      });
      totalUnread += sub.unreadCount;
    }
  }

  if (savedFeed && savedFeed.unreadCount > 0) {
    unreadcounts.push({
      id: feedStreamId(savedFeed.feedId),
      count: savedFeed.unreadCount,
      newestItemTimestampUsec: Date.now().toString() + "000",
    });
    totalUnread += savedFeed.unreadCount;
  }

  // Add total unread count for reading-list
  if (totalUnread > 0) {
    unreadcounts.push({
      id: stateStreamId("reading-list"),
      count: totalUnread,
      newestItemTimestampUsec: Date.now().toString() + "000",
    });
  }

  return {
    max: 1000,
    unreadcounts,
  };
}

// ============================================================================
// User Info Formatting
// ============================================================================

export function formatUserInfo(userId: string, email: string) {
  return {
    userId: uuidToInt64(userId).toString(),
    userName: email,
    userProfileId: uuidToInt64(userId).toString(),
    userEmail: email,
    isBloggerUser: false,
    signupTimeSec: 0,
    isMultiLoginEnabled: false,
  };
}
