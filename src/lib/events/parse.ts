/**
 * SSE Event Parsing
 */

import { SYNC_PROTOCOL_VERSION, syncEventSchema, type SyncEvent } from "./schemas";

/**
 * Parses SSE event data from a JSON string into a SyncEvent.
 *
 * Checks the wire protocol version first: an event whose `v` is missing or
 * different was published by a different release (rolling deploy window) and
 * may lack fields the current schemas require, so it returns "outdated" and
 * the caller responds with one full catch-up sync instead of interpreting it.
 *
 * For current-version events, uses the shared Zod schema for validation, which
 * strips extra server fields (userId, feedId, v) and applies defaults for
 * optional fields like timestamp. Returns null if the data is invalid or
 * doesn't match a known event type.
 */
export function parseSyncEvent(data: string): SyncEvent | "outdated" | null {
  try {
    const raw: unknown = JSON.parse(data);
    if (
      typeof raw !== "object" ||
      raw === null ||
      (raw as { v?: unknown }).v !== SYNC_PROTOCOL_VERSION
    ) {
      return typeof raw === "object" && raw !== null ? "outdated" : null;
    }
    const result = syncEventSchema.safeParse(raw);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}
