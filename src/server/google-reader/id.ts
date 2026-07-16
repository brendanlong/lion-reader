/**
 * ID conversions for the Google Reader API.
 *
 * Google Reader clients require signed 64-bit integer IDs. Lion Reader uses
 * UUIDv7 (128-bit) internally, so every id a client sees is a stored serial
 * (issue #1117): each entry, subscription, feed, tag, and user carries a plain
 * bigint drawn from a Postgres sequence, so formatting reads it directly and the
 * reversible ids (item ids, feed stream ids) are unique-index seeks — no runtime
 * UUID→int64 projection and no timestamp-window candidate scan.
 *
 * - **Item ids** (`entries.greader_item_id`): reversed by `greaderItemIdsToUuids`.
 *   The Wallabag API exposes the same serial as its entry id
 *   (src/server/wallabag/id.ts).
 * - **Feed stream ids** (`subscriptions.greader_stream_id` /
 *   `feeds.greader_stream_id`): reversed by `feedStreamIdToSubscriptionUuid` /
 *   `resolveFeedStream`. Both tables draw from the same sequence so their ids are
 *   globally unique — a `feed/{int}` resolves to at most one of {subscription,
 *   saved feed}.
 * - **Tag sortids** (`tags.greader_sortid`) and **user ids**
 *   (`users.greader_user_id`) are opaque (never reversed) and read directly at
 *   format time.
 *
 * Clients send ids in three formats (all parsed by `parseItemId`):
 * - Long hex: tag:google.com,2005:reader/item/000000000000001F
 * - Short hex: 000000000000001F
 * - Decimal string: 31
 */

import { and, eq, inArray } from "drizzle-orm";
import type { db as dbType } from "@/server/db";
import { feeds, subscriptions, visibleEntries } from "@/server/db/schema";

/**
 * Formats an int64 as a long-form Google Reader item ID.
 * e.g., "tag:google.com,2005:reader/item/00000191a2b3c4d5"
 */
export function int64ToLongFormId(id: bigint): string {
  const hex = id.toString(16).padStart(16, "0");
  return `tag:google.com,2005:reader/item/${hex}`;
}

/**
 * Formats an int64 as a short hex string (16 chars, zero-padded).
 */
export function int64ToShortHex(id: bigint): string {
  return id.toString(16).padStart(16, "0");
}

/**
 * Parses a Google Reader item ID from any of the three formats clients send:
 * - Long hex: "tag:google.com,2005:reader/item/000000000000001F"
 * - Short hex: "000000000000001F"
 * - Decimal string: "31"
 *
 * Returns the parsed bigint value.
 */
export function parseItemId(id: string): bigint {
  // Long-form tag URI
  const longPrefix = "tag:google.com,2005:reader/item/";
  if (id.startsWith(longPrefix)) {
    const hex = id.slice(longPrefix.length);
    return BigInt("0x" + hex);
  }

  // Short hex (16 hex chars)
  if (/^[0-9a-fA-F]{16}$/.test(id)) {
    return BigInt("0x" + id);
  }

  // Decimal string
  if (/^-?\d+$/.test(id)) {
    return BigInt(id);
  }

  throw new Error(`Invalid Google Reader item ID format: ${id}`);
}

/** Signed 64-bit integer bounds (Postgres bigint range). */
const INT64_MIN = -(BigInt(2) ** BigInt(63));
const INT64_MAX = BigInt(2) ** BigInt(63) - BigInt(1);

/**
 * Whether an id fits in Postgres's signed bigint range (else it can't match a
 * stored serial). Also used by the Wallabag id resolution, which seeks the same
 * stored serials (src/server/wallabag/id.ts).
 */
export function isInt64(id: bigint): boolean {
  return id >= INT64_MIN && id <= INT64_MAX;
}

/**
 * Resolves Google Reader item IDs (stored `entries.greader_item_id` serials) to
 * their UUIDv7 entry IDs, **scoped to the requesting user**. Item ids are a
 * plain stored bigint, so this is a single `greader_item_id = ANY(ids)` seek —
 * no timestamp math, no candidate disambiguation. The seek runs through
 * `visible_entries`, so an item id another user owns (or one the user can't see)
 * resolves to nothing, exactly like `resolveWallabagEntry` / `resolveFeedStream`
 * — the resolved UUIDs are safe to read content off of directly. Ids with no
 * visible matching row (deleted, invisible, or a bogus value a client sent) are
 * simply absent from the returned map.
 *
 * Ids outside the signed 64-bit range are skipped before querying: `parseItemId`
 * accepts unbounded hex/decimal input (e.g. 16 hex f's = 2^64-1), and a
 * parameter that exceeds Postgres's bigint range makes Postgres reject the
 * whole query — poisoning the batch. Such ids can't match a stored serial
 * anyway, so they're simply left unresolved.
 */
export async function greaderItemIdsToUuids(
  db: typeof dbType,
  userId: string,
  ids: bigint[]
): Promise<Map<bigint, string>> {
  const result = new Map<bigint, string>();

  const validIds = ids.filter(isInt64);
  if (validIds.length === 0) return result;

  const rows = await db
    .select({ id: visibleEntries.id, greaderItemId: visibleEntries.greaderItemId })
    .from(visibleEntries)
    .where(and(eq(visibleEntries.userId, userId), inArray(visibleEntries.greaderItemId, validIds)));

  for (const row of rows) {
    result.set(row.greaderItemId, row.id);
  }

  return result;
}

/**
 * Builds a Google Reader feed stream ID ("feed/{int64}") from a stored stream
 * serial (`subscriptions.greader_stream_id` for a real subscription, or
 * `feeds.greader_stream_id` for the per-user saved-articles feed — issue #730).
 */
export function feedStreamId(streamId: bigint): string {
  return `feed/${streamId.toString()}`;
}

/**
 * Converts a Google Reader feed stream ID to its int64.
 * Input: "feed/{int64}" -> bigint
 */
export function parseFeedStreamId(streamId: string): bigint {
  if (!streamId.startsWith("feed/")) {
    throw new Error(`Invalid feed stream ID: ${streamId}`);
  }
  return BigInt(streamId.slice(5));
}

/**
 * Looks up a subscription UUID from a Google Reader feed stream int64 ID — a
 * single unique-index seek on `subscriptions.greader_stream_id`, scoped to the
 * user. Returns null when nothing matches (unknown id, another user's
 * subscription, or an id outside the bigint range — a client can send an
 * arbitrarily large `feed/{n}`, which would otherwise poison the query).
 */
export async function feedStreamIdToSubscriptionUuid(
  db: typeof dbType,
  userId: string,
  streamId: bigint
): Promise<string | null> {
  if (!isInt64(streamId)) return null;

  const [row] = await db
    .select({ id: subscriptions.id })
    .from(subscriptions)
    .where(and(eq(subscriptions.userId, userId), eq(subscriptions.greaderStreamId, streamId)))
    .limit(1);

  return row?.id ?? null;
}

/**
 * A resolved `feed/{int64}` stream: either a real subscription or the user's
 * synthetic saved-articles feed (which has no subscription row and is exposed
 * to Google Reader clients as an uncategorized "Saved Articles" subscription —
 * see issue #730).
 */
export type FeedStreamResolution =
  | { kind: "subscription"; subscriptionId: string }
  | { kind: "saved"; feedId: string };

/**
 * Resolves a `feed/{int64}` stream ID to either a subscription or the user's
 * saved-articles feed. Tries subscriptions first (the common case); if none
 * matches, checks the user's saved feed. Subscriptions and feeds draw their
 * stream ids from the same sequence, so the two seeks can never both match.
 * Returns null when it matches nothing the user owns.
 */
export async function resolveFeedStream(
  db: typeof dbType,
  userId: string,
  streamId: bigint
): Promise<FeedStreamResolution | null> {
  if (!isInt64(streamId)) return null;

  const subscriptionId = await feedStreamIdToSubscriptionUuid(db, userId, streamId);
  if (subscriptionId) {
    return { kind: "subscription", subscriptionId };
  }

  const [saved] = await db
    .select({ id: feeds.id })
    .from(feeds)
    .where(
      and(eq(feeds.userId, userId), eq(feeds.type, "saved"), eq(feeds.greaderStreamId, streamId))
    )
    .limit(1);

  return saved ? { kind: "saved", feedId: saved.id } : null;
}
