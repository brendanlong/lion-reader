/**
 * Hooks exports
 *
 * Centralized exports for custom React hooks.
 */

export { useKeyboardShortcuts } from "./useKeyboardShortcuts";

export { getViewPreferences, type ViewType } from "./viewPreferences";

export { useUrlViewPreferences, parseViewPreferencesFromParams } from "./useUrlViewPreferences";

export { useEntryMutations, type EntryListFilters } from "./useEntryMutations";

// Re-export EntryType from the store for convenience
export { type EntryType } from "@/lib/store/realtime";

export { useEntryWithDeltas, useMergedEntries, type EntryFilterOptions } from "./useEntryDeltas";

export { useEntryUrlState } from "./useEntryUrlState";

export { useExpandedTags } from "./useExpandedTags";

export { useEntryListQuery, type EntryListData } from "./useEntryListQuery";

export { useShowOriginalPreference } from "./useShowOriginalPreference";

export { useEntryPage, type UseEntryPageOptions, type UseEntryPageResult } from "./useEntryPage";
