/**
 * UUIDv7 ↔ signed 64-bit integer conversion for Google Reader API.
 *
 * Google Reader clients require signed 64-bit integer IDs. Lion Reader uses UUIDv7 (128-bit).
 *
 * Strategy: Derive int64 deterministically from UUIDv7 at runtime (no storage needed).
 *
 * UUIDv7 layout: [48-bit ms timestamp][4-bit version][12-bit rand_a][2-bit variant][62-bit rand_b]
 *
 * We extract 48 bits of timestamp + 15 bits of randomness (from rand_a[0:11] + rand_b[0:3],
 * skipping version/variant markers) to produce a 63-bit positive signed integer.
 *
 * This is:
 * - Time-ordered — same sort order as the UUID
 * - Unique — 48-bit ms timestamp + 15 bits random = collision only if 32K+ entries in same ms
 * - Deterministic — same UUID always produces the same integer
 * - Reversible — timestamp narrows lookup to one millisecond, random bits disambiguate
 *
 * Clients send IDs in three formats (all must be parsed):
 * - Long hex: tag:google.com,2005:reader/item/000000000000001F
 * - Short hex: 000000000000001F
 * - Decimal string: 31
 */

import { eq, and, gte, lte, sql } from "drizzle-orm";
import type { db as dbType } from "@/server/db";
import { entries, subscriptions } from "@/server/db/schema";

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
 * The lowest/highest UUID sharing a given 12-hex-digit timestamp prefix. Because
 * UUIDv7 text-orders by timestamp, `id BETWEEN floor(minTs) AND ceil(maxTs)` is
 * an index-seekable bound on the primary key that brackets every UUID in the
 * requested time window — turning a full index scan (the substring filter alone
 * can't use the index) into a range scan.
 */
function uuidFloor(tsHex: string): string {
  return `${tsHex.slice(0, 8)}-${tsHex.slice(8, 12)}-0000-0000-000000000000`;
}
function uuidCeil(tsHex: string): string {
  return `${tsHex.slice(0, 8)}-${tsHex.slice(8, 12)}-ffff-ffff-ffffffffffff`;
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

/**
 * Batch converts Google Reader int64 IDs to UUIDv7 entry IDs.
 *
 * The int64 is a lossy projection of the UUID (48-bit timestamp + 15 random
 * bits), so we can't reconstruct the UUID directly — we fetch the candidate
 * UUIDs sharing each requested timestamp and disambiguate by the random bits in
 * JS. All distinct timestamps are matched in a SINGLE query: an earlier version
 * ran one query per distinct millisecond, which for a large sync page (e.g. 250
 * ids from stream/items/contents) became 250 sequential round-trips — the
 * dominant cost of the request. UUIDv7 encodes creation time at millisecond
 * resolution, so entries arriving over time rarely share one, making the old
 * grouping degenerate to one query per id.
 */
export async function batchInt64ToUuid(
  db: typeof dbType,
  ids: bigint[]
): Promise<Map<bigint, string>> {
  const result = new Map<bigint, string>();

  if (ids.length === 0) return result;

  // Distinct timestamp prefixes to match in one query.
  const timestamps = ids.map(extractTimestamp);
  const tsHexes = [...new Set(timestamps.map(timestampHex))];
  let minTs = timestamps[0];
  let maxTs = timestamps[0];
  for (const ts of timestamps) {
    if (ts < minTs) minTs = ts;
    if (ts > maxTs) maxTs = ts;
  }

  // Match all candidates in a single query, then disambiguate by random bits.
  // The BETWEEN bound makes the primary-key index seek the requested time window
  // instead of scanning the whole index; the substring IN then selects the exact
  // milliseconds within it. The per-timestamp cap of the old code (1000) is
  // preserved in aggregate so a pathological millisecond can't blow up results.
  const candidates = await db
    .select({ id: entries.id })
    .from(entries)
    .where(
      and(
        gte(entries.id, uuidFloor(timestampHex(minTs))),
        lte(entries.id, uuidCeil(timestampHex(maxTs))),
        uuidTimestampIn(entries.id, tsHexes)
      )
    )
    .limit(tsHexes.length * 1000);

  // Index candidates by their derived int64 for O(1) lookup, then resolve each
  // requested id. A collision (32K+ entries in one ms) is astronomically
  // unlikely; last-writer-wins is acceptable there.
  const byInt64 = new Map<bigint, string>();
  for (const candidate of candidates) {
    byInt64.set(uuidToInt64(candidate.id), candidate.id);
  }
  for (const id of ids) {
    const uuid = byInt64.get(id);
    if (uuid !== undefined) result.set(id, uuid);
  }

  return result;
}

/**
 * Converts a subscription UUIDv7 to a Google Reader feed stream ID.
 * Format: "feed/{int64}"
 */
export function subscriptionToStreamId(subscriptionId: string): string {
  return `feed/${uuidToInt64(subscriptionId).toString()}`;
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
