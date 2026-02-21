/**
 * Google Reader Stream ID Parsing
 *
 * Stream IDs identify collections of items (entries) in the Google Reader API.
 *
 * Supported stream ID formats:
 * - `feed/{subscriptionInt64}` — entries from a specific subscription
 * - `user/-/state/com.google/reading-list` — all entries
 * - `user/-/state/com.google/read` — read entries
 * - `user/-/state/com.google/starred` — starred entries
 * - `user/-/label/{name}` — entries in a tag/folder
 * - `user/{userId}/state/com.google/reading-list` — same as user/-/ variant
 * - `user/{userId}/state/com.google/starred` — same as user/-/ variant
 * - `user/{userId}/label/{name}` — same as user/-/ variant
 */

/**
 * Recognized system state stream types.
 */
export type SystemState = "reading-list" | "read" | "starred" | "broadcast" | "kept-unread";

/**
 * Parsed stream ID.
 */
export type StreamId =
  | { type: "feed"; subscriptionInt64: bigint }
  | { type: "state"; state: SystemState }
  | { type: "label"; name: string };

/**
 * Parses a Google Reader stream ID string.
 *
 * Accepts both `user/-/...` and `user/{userId}/...` formats.
 * The userId in `user/{userId}/...` is ignored (we use the authenticated user).
 */
export function parseStreamId(streamId: string): StreamId {
  // feed/{int64}
  if (streamId.startsWith("feed/")) {
    const idStr = streamId.slice(5);
    return { type: "feed", subscriptionInt64: BigInt(idStr) };
  }

  // Normalize user/{anything}/ to user/-/
  const userPrefixMatch = streamId.match(/^user\/[^/]+\/(.*)/);
  if (!userPrefixMatch) {
    throw new Error(`Invalid stream ID: ${streamId}`);
  }

  const rest = userPrefixMatch[1];

  // state/com.google/{state}
  const stateMatch = rest.match(/^state\/com\.google\/(.+)$/);
  if (stateMatch) {
    const state = stateMatch[1] as SystemState;
    const validStates: SystemState[] = [
      "reading-list",
      "read",
      "starred",
      "broadcast",
      "kept-unread",
    ];
    if (!validStates.includes(state)) {
      throw new Error(`Unknown system state: ${state}`);
    }
    return { type: "state", state };
  }

  // label/{name}
  const labelMatch = rest.match(/^label\/(.+)$/);
  if (labelMatch) {
    return { type: "label", name: labelMatch[1] };
  }

  throw new Error(`Invalid stream ID: ${streamId}`);
}

/**
 * Builds a system state stream ID string.
 */
export function stateStreamId(state: SystemState): string {
  return `user/-/state/com.google/${state}`;
}

/**
 * Builds a label stream ID string.
 */
export function labelStreamId(name: string): string {
  return `user/-/label/${name}`;
}

/**
 * Checks if a stream ID string represents a specific system state.
 */
export function isState(streamId: string, state: SystemState): boolean {
  try {
    const parsed = parseStreamId(streamId);
    return parsed.type === "state" && parsed.state === state;
  } catch {
    return false;
  }
}
