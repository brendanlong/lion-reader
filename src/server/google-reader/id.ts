/**
 * ID conversions for the Google Reader API.
 *
 * Google Reader clients require signed 64-bit integer IDs. Lion Reader uses UUIDv7 (128-bit).
 *
 * **Item IDs** are a stored global serial (`entries.greader_item_id`): each entry
 * carries a plain bigint, so formatting reads it directly and the reverse lookup
 * (`greaderItemIdsToUuids`) is a `greader_item_id = ANY(...)` seek on a unique
 * index — no derivation, no timestamp-window scan.
 *
 * The **UUID→int64 projection** (`uuidToInt64`) remains only for the ids that are
 * still derived at runtime: feed stream ids, tag sortids, and user ids (a later
 * step migrates those too).
 *
 * uuidToInt64 layout: UUIDv7 is [48-bit ms timestamp][4-bit version][12-bit
 * rand_a][2-bit variant][62-bit rand_b]. We extract 48 bits of timestamp + 15
 * bits of randomness (rand_a[0:11] + rand_b[0:3], skipping version/variant
 * markers) to produce a 63-bit positive signed integer that is time-ordered,
 * deterministic, and (for feed streams) reversible — the timestamp narrows a
 * lookup to one millisecond and the random bits disambiguate.
 *
 * Clients send item IDs in three formats (all must be parsed):
 * - Long hex: tag:google.com,2005:reader/item/000000000000001F
 * - Short hex: 000000000000001F
 * - Decimal string: 31
 */

import { eq, and, inArray, sql } from "drizzle-orm";
import type { db as dbType } from "@/server/db";
import { entries, subscriptions } from "@/server/db/schema";
import { getSavedFeedId } from "@/server/feed/saved-feed";

/**
 * Converts a UUIDv7 string to a signed 63-bit integer (as bigint).
 *
 * Extracts 48-bit timestamp + 15 bits of randomness, producing a 63-bit positive value.
 */
export function uuidToInt64(uuid: string): bigint {
  // Remove hyphens and parse as hex bytes
  const hex = uuid.replace(/-/g, "");
  // bytes[0..5] = 48-bit timestamp
  // bytes[6] high nibble = version (skip), low nibble = rand_a[0:3]
  // bytes[7] = rand_a[4:11]
  // bytes[8] high 2 bits = variant (skip), low 6 bits = rand_b[0:5]

  // Extract 48-bit timestamp (bytes 0-5)
  const timestampHex = hex.slice(0, 12);
  const timestamp = BigInt("0x" + timestampHex);

  // Extract 12 bits of rand_a (low nibble of byte 6 + byte 7)
  const randAHex = hex.slice(13, 16); // skip version nibble at position 12
  const randA = BigInt("0x" + randAHex);

  // Extract 3 bits from rand_b (bits 0-2 of byte 8, after variant)
  const byte8 = parseInt(hex.slice(16, 18), 16);
  const randB3 = BigInt(byte8 & 0x3f) >> BigInt(3); // top 3 bits of the 6-bit portion

  // Combine: 48 bits timestamp + 12 bits rand_a + 3 bits rand_b = 63 bits
  const result = (timestamp << BigInt(15)) | (randA << BigInt(3)) | randB3;

  return result;
}

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

/**
 * Extracts the 48-bit millisecond timestamp from an int64 ID.
 */
function extractTimestamp(id: bigint): bigint {
  return id >> BigInt(15);
}

/**
 * Extracts the 15-bit random portion from an int64 ID.
 */
function extractRandomBits(id: bigint): bigint {
  return id & BigInt(0x7fff); // lower 15 bits
}

/** Formats a 48-bit millisecond timestamp as its 12-hex-digit UUID prefix. */
function timestampHex(timestampMs: bigint): string {
  return timestampMs.toString(16).padStart(12, "0");
}

/**
 * Builds a SQL condition matching UUIDs whose timestamp-prefix hex is in the
 * given set. UUIDs are stored as text like "xxxxxxxx-xxxx-...". The first 12 hex
 * digits (positions 1-8 and 10-13, skipping the hyphen) encode the 48-bit
 * millisecond timestamp.
 */
function uuidTimestampIn(column: typeof entries.id | typeof subscriptions.id, tsHexes: string[]) {
  const list = sql.join(
    tsHexes.map((h) => sql`${h}`),
    sql`, `
  );
  return sql`SUBSTRING(${column}::text, 1, 8) || SUBSTRING(${column}::text, 10, 4) IN (${list})`;
}

/** Signed 64-bit integer bounds (Postgres bigint range). */
const INT64_MIN = -(BigInt(2) ** BigInt(63));
const INT64_MAX = BigInt(2) ** BigInt(63) - BigInt(1);

/**
 * Resolves Google Reader item IDs (stored `entries.greader_item_id` serials) to
 * their UUIDv7 entry IDs. Item ids are a plain stored bigint, so this is a
 * single `greader_item_id = ANY(ids)` seek on the unique index — no timestamp
 * math, no candidate disambiguation. Ids with no matching row (deleted, or a
 * bogus value a client sent) are simply absent from the returned map.
 *
 * Ids outside the signed 64-bit range are skipped before querying: `parseItemId`
 * accepts unbounded hex/decimal input (e.g. 16 hex f's = 2^64-1), and a
 * parameter that exceeds Postgres's bigint range makes Postgres reject the
 * whole query — poisoning the batch. Such ids can't match a stored serial
 * anyway, so they're simply left unresolved.
 */
export async function greaderItemIdsToUuids(
  db: typeof dbType,
  ids: bigint[]
): Promise<Map<bigint, string>> {
  const result = new Map<bigint, string>();

  const validIds = ids.filter((id) => id >= INT64_MIN && id <= INT64_MAX);
  if (validIds.length === 0) return result;

  const rows = await db
    .select({ id: entries.id, greaderItemId: entries.greaderItemId })
    .from(entries)
    .where(inArray(entries.greaderItemId, validIds));

  for (const row of rows) {
    result.set(row.greaderItemId, row.id);
  }

  return result;
}

/**
 * Builds a Google Reader feed stream ID ("feed/{int64}") from any feed-like
 * UUID. Regular feeds are addressed by their *subscription* UUID (the
 * subscription-centric model), while the per-user saved-articles feed has no
 * subscription and is addressed by its own `feeds.id`. Both are just UUIDv7s
 * projected to a 63-bit int, so the same encoding works for either.
 */
export function feedStreamId(uuid: string): string {
  return `feed/${uuidToInt64(uuid).toString()}`;
}

/**
 * Converts a subscription UUIDv7 to a Google Reader feed stream ID.
 * Format: "feed/{int64}"
 */
export function subscriptionToStreamId(subscriptionId: string): string {
  return feedStreamId(subscriptionId);
}

/**
 * Converts a Google Reader feed stream ID to a subscription int64.
 * Input: "feed/{int64}" -> bigint
 */
export function parseFeedStreamId(streamId: string): bigint {
  if (!streamId.startsWith("feed/")) {
    throw new Error(`Invalid feed stream ID: ${streamId}`);
  }
  return BigInt(streamId.slice(5));
}

/**
 * Looks up a subscription UUID from a Google Reader feed stream int64 ID.
 */
export async function feedStreamIdToSubscriptionUuid(
  db: typeof dbType,
  userId: string,
  streamId: bigint
): Promise<string | null> {
  const randomBits = extractRandomBits(streamId);
  const tsHex = timestampHex(extractTimestamp(streamId));

  const candidates = await db
    .select({ id: subscriptions.id })
    .from(subscriptions)
    .where(and(eq(subscriptions.userId, userId), uuidTimestampIn(subscriptions.id, [tsHex])))
    .limit(100);

  for (const candidate of candidates) {
    const candidateInt64 = uuidToInt64(candidate.id);
    if (extractRandomBits(candidateInt64) === randomBits) {
      return candidate.id;
    }
  }

  return null;
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
 * matches, checks whether the int64 is the saved feed's own id. Returns null
 * when it matches nothing the user owns.
 */
export async function resolveFeedStream(
  db: typeof dbType,
  userId: string,
  streamId: bigint
): Promise<FeedStreamResolution | null> {
  const subscriptionId = await feedStreamIdToSubscriptionUuid(db, userId, streamId);
  if (subscriptionId) {
    return { kind: "subscription", subscriptionId };
  }

  const savedFeedId = await getSavedFeedId(db, userId);
  if (savedFeedId && uuidToInt64(savedFeedId) === streamId) {
    return { kind: "saved", feedId: savedFeedId };
  }

  return null;
}
