/**
 * Count Cache Helpers
 *
 * Utility functions for computing tag deltas from subscription deltas.
 * Uses TanStack DB collections for subscription lookups.
 */

import type { Collections } from "@/lib/collections";

/**
 * Result of calculating tag deltas from subscription deltas.
 */
export interface TagDeltaResult {
  tagDeltas: Map<string, number>;
  uncategorizedDelta: number;
}

/**
 * Calculates tag deltas from subscription deltas.
 * Looks up subscription data from the TanStack DB collection to determine
 * which tags each subscription belongs to.
 *
 * @param subscriptionDeltas - Map of subscriptionId -> count change
 * @param collections - TanStack DB collections for subscription lookups
 * @returns Tag deltas and uncategorized delta
 */
export function calculateTagDeltasFromSubscriptions(
  subscriptionDeltas: Map<string, number>,
  collections: Collections | null
): TagDeltaResult {
  const tagDeltas = new Map<string, number>();
  let uncategorizedDelta = 0;

  if (!collections) return { tagDeltas, uncategorizedDelta };

  for (const [subscriptionId, delta] of subscriptionDeltas) {
    const subscription = collections.subscriptions.get(subscriptionId);
    if (subscription) {
      if (subscription.tags.length === 0) {
        uncategorizedDelta += delta;
      } else {
        for (const tag of subscription.tags) {
          const currentDelta = tagDeltas.get(tag.id) ?? 0;
          tagDeltas.set(tag.id, currentDelta + delta);
        }
      }
    }
  }

  return { tagDeltas, uncategorizedDelta };
}
