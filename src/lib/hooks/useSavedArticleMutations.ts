/**
 * useSavedArticleMutations Hook
 *
 * Re-exports useEntryMutations for saved articles.
 * The underlying mutations (markRead, star, unstar) work identically
 * for both feed entries and saved articles since they use the same endpoints.
 *
 * This file is kept for backwards compatibility and semantic clarity -
 * saved articles pages can import `useSavedArticleMutations` to make
 * their intent clear, even though it's the same hook internally.
 */

"use client";

import {
  useEntryMutations,
  type UseEntryMutationsOptions,
  type UseEntryMutationsResult,
} from "./useEntryMutations";

/**
 * Options for the useSavedArticleMutations hook.
 * Same as UseEntryMutationsOptions since they share the same implementation.
 */
export type UseSavedArticleMutationsOptions = UseEntryMutationsOptions;

/**
 * Result of the useSavedArticleMutations hook.
 * Same as UseEntryMutationsResult since they share the same implementation.
 */
export type UseSavedArticleMutationsResult = UseEntryMutationsResult;

/**
 * Hook that provides saved article mutations with optimistic updates.
 *
 * This is an alias for useEntryMutations - the underlying implementation
 * is identical since feed entries and saved articles use the same API endpoints.
 *
 * @param options - Options including list filters for optimistic updates
 * @returns Object with mutation functions and pending state
 */
export function useSavedArticleMutations(
  options?: UseSavedArticleMutationsOptions
): UseSavedArticleMutationsResult {
  return useEntryMutations(options);
}
