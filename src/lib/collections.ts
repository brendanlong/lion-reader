/** Limits and labels for collections, shared by the server and the UI. */

export const COLLECTION_NAME_MAX_LENGTH = 255;

/** Most articles one add/remove call may name. */
export const MAX_COLLECTION_BATCH = 1000;

/** Most collections one save or upload may put an article in. */
export const MAX_SAVE_COLLECTIONS = 100;

/**
 * Most articles one collection may hold. Every membership change recomputes
 * the owner's list counters over their collection members, so this bounds
 * that cost.
 */
export const MAX_COLLECTION_ENTRIES = 10_000;

/** What to call a subscription that has no title. */
export function untitledSubscriptionLabel(type: string): string {
  return type === "collection" ? "Untitled Collection" : "Untitled Feed";
}
