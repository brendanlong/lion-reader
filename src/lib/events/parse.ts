/**
 * SSE Event Parsing
 */

import { syncEventSchema, type SyncEvent } from "./schemas";

/**
 * Parses SSE event data from a JSON string into a SyncEvent.
 * Uses the shared Zod schema for validation, which strips extra server fields
 * (userId, feedId) and applies defaults for optional fields like timestamp.
 * Returns null if the data is invalid or doesn't match a known event type.
 */
export function parseSyncEvent(data: string): SyncEvent | null {
  try {
    const result = syncEventSchema.safeParse(JSON.parse(data));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}
