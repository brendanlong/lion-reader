/**
 * Hooks exports
 *
 * Centralized exports for custom React hooks.
 */

export {
  useRealtimeUpdates,
  type ConnectionStatus,
  type UseRealtimeUpdatesResult,
} from "./useRealtimeUpdates";

export {
  useKeyboardShortcuts,
  type KeyboardEntryData,
  type UseKeyboardShortcutsOptions,
  type UseKeyboardShortcutsResult,
} from "./useKeyboardShortcuts";

export {
  useKeyboardShortcutsEnabled,
  type UseKeyboardShortcutsEnabledResult,
} from "./useKeyboardShortcutsEnabled";

export {
  useSavedArticleKeyboardShortcuts,
  type SavedArticleKeyboardData,
  type UseSavedArticleKeyboardShortcutsOptions,
  type UseSavedArticleKeyboardShortcutsResult,
} from "./useSavedArticleKeyboardShortcuts";

export {
  useNarrationKeyboardShortcuts,
  type NarrationShortcutState,
  type NarrationShortcutControls,
  type UseNarrationKeyboardShortcutsOptions,
} from "./useNarrationKeyboardShortcuts";

export {
  useViewPreferences,
  getViewPreferences,
  type ViewType,
  type ViewPreferences,
  type UseViewPreferencesResult,
} from "./useViewPreferences";

export {
  useEntryMutations,
  type EntryListFilters,
  type MarkAllReadOptions,
  type UseEntryMutationsOptions,
  type UseEntryMutationsResult,
} from "./useEntryMutations";

export {
  useSavedArticleMutations,
  type SavedArticleListFilters,
  type UseSavedArticleMutationsOptions,
  type UseSavedArticleMutationsResult,
} from "./useSavedArticleMutations";

export { useEntryUrlState, type UseEntryUrlStateResult } from "./useEntryUrlState";

export {
  useSwipeGestures,
  type UseSwipeGesturesOptions,
  type UseSwipeGesturesResult,
} from "./useSwipeGestures";

export { useExpandedTags, type UseExpandedTagsResult } from "./useExpandedTags";

export {
  useEntryListQuery,
  type EntryListQueryFilters,
  type EntryListData,
  type UseEntryListQueryOptions,
  type UseEntryListQueryResult,
} from "./useEntryListQuery";
