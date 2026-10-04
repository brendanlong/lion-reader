/**
 * Tag cache helpers: apply tag events to the `tags.list` cache.
 */

import type { TRPCClientUtils } from "@/lib/trpc/client";

// ============================================================================
// Tag Cache Direct Updates (for sync)
// ============================================================================

/**
 * Tag data for sync operations.
 */
export interface SyncTag {
  id: string;
  name: string;
  color: string | null;
}

/**
 * Updates or adds tags in the tags.list cache based on sync data.
 * Does not invalidate - directly applies changes.
 *
 * @param utils - tRPC utils for cache access
 * @param createdTags - Tags that are newly created
 * @param updatedTags - Tags that have been updated
 */
export function applySyncTagChanges(
  utils: TRPCClientUtils,
  createdTags: SyncTag[],
  updatedTags: SyncTag[]
): void {
  if (createdTags.length === 0 && updatedTags.length === 0) return;

  utils.tags.list.setData(undefined, (oldData) => {
    if (!oldData) return oldData;

    // Create a map for efficient lookups
    const updatedTagsMap = new Map(updatedTags.map((t) => [t.id, t]));

    // Update existing tags
    let items = oldData.items.map((tag) => {
      const update = updatedTagsMap.get(tag.id);
      if (update) {
        return {
          ...tag,
          name: update.name,
          color: update.color,
        };
      }
      return tag;
    });

    // Add newly created tags (with default counts)
    for (const newTag of createdTags) {
      // Check for duplicates (race condition)
      if (!items.some((t) => t.id === newTag.id)) {
        items.push({
          id: newTag.id,
          name: newTag.name,
          color: newTag.color,
          feedCount: 0,
          unreadCount: 0,
          createdAt: new Date(), // Approximate, doesn't need to be exact
        });
      }
    }

    // Sort by name (matching server behavior)
    items = items.sort((a, b) => a.name.localeCompare(b.name));

    return {
      ...oldData,
      items,
    };
  });
}

/**
 * Removes tags from the tags.list cache based on sync data.
 * Does not invalidate - directly removes from cache.
 *
 * @param utils - tRPC utils for cache access
 * @param removedTagIds - IDs of tags to remove
 */
export function removeSyncTags(utils: TRPCClientUtils, removedTagIds: string[]): void {
  if (removedTagIds.length === 0) return;

  const removedSet = new Set(removedTagIds);

  utils.tags.list.setData(undefined, (oldData) => {
    if (!oldData) return oldData;

    return {
      ...oldData,
      items: oldData.items.filter((tag) => !removedSet.has(tag.id)),
    };
  });
}
