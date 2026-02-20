/**
 * Google Reader API Response Formatting
 *
 * Transforms Lion Reader service data into the JSON format expected
 * by Google Reader clients.
 */

import { uuidToInt64, int64ToLongFormId, subscriptionToStreamId } from "./id";
import { stateStreamId, labelStreamId } from "./streams";
import type { EntryFull, EntryListItem } from "@/server/services/entries";
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
      streamId: entry.subscriptionId ? subscriptionToStreamId(entry.subscriptionId) : "",
      title: entry.feedTitle ?? "",
      htmlUrl: entry.feedUrl ?? entry.url ?? "",
    },
    categories,
  };
}

/**
 * Formats a list entry (without content) as a Google Reader item.
 * Used when full content is not needed (e.g., stream/items/ids).
 */
export function formatListEntryAsItem(
  entry: EntryListItem
): Omit<GoogleReaderItem, "summary"> & { summary: { direction: string; content: string } } {
  const itemId = uuidToInt64(entry.id);
  const publishedTs = entry.publishedAt
    ? Math.floor(entry.publishedAt.getTime() / 1000)
    : Math.floor(entry.fetchedAt.getTime() / 1000);
  const updatedTs = Math.floor(entry.updatedAt.getTime() / 1000);
  const crawlTimeMs = entry.fetchedAt.getTime().toString();

  const categories: string[] = [];
  categories.push(stateStreamId("reading-list"));
  if (entry.read) {
    categories.push(stateStreamId("read"));
  }
  if (entry.starred) {
    categories.push(stateStreamId("starred"));
  }

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
      content: entry.summary ?? "",
    },
    author: entry.author ?? "",
    origin: {
      streamId: entry.subscriptionId ? subscriptionToStreamId(entry.subscriptionId) : "",
      title: entry.feedTitle ?? "",
      htmlUrl: entry.url ?? "",
    },
    categories,
  };
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
    id: `feed/${int64Id.toString()}`,
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
 */
export function formatUnreadCounts(
  subscriptions: Array<{ id: string; unreadCount: number; subscribedAt: Date }>
): {
  max: number;
  unreadcounts: GoogleReaderUnreadCount[];
} {
  const unreadcounts: GoogleReaderUnreadCount[] = [];

  let totalUnread = 0;
  for (const sub of subscriptions) {
    if (sub.unreadCount > 0) {
      const int64Id = uuidToInt64(sub.id);
      unreadcounts.push({
        id: `feed/${int64Id.toString()}`,
        count: sub.unreadCount,
        newestItemTimestampUsec: (sub.subscribedAt.getTime() * 1000).toString(),
      });
      totalUnread += sub.unreadCount;
    }
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
