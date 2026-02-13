/**
 * Counts Collection
 *
 * Local-only collection for entry counts (total/unread).
 * Updated from server responses after mutations and SSE events.
 * Not synced to any backend - purely derived client-side state.
 */

import { createCollection, localOnlyCollectionOptions } from "@tanstack/react-db";
import type { CountRecord } from "./types";

/**
 * Creates the counts collection as a local-only store.
 *
 * Count records are keyed by string identifiers:
 * - "all" - All entries count
 * - "starred" - Starred entries count
 * - "saved" - Saved articles count
 *
 * These are populated from server responses (entries.count, mutation results)
 * and updated optimistically during mutations.
 */
export function createCountsCollection() {
  return createCollection(
    localOnlyCollectionOptions({
      id: "counts",
      getKey: (item: CountRecord) => item.id,
    })
  );
}

export type CountsCollection = ReturnType<typeof createCountsCollection>;
