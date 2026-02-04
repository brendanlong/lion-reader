/**
 * Hooks exports
 *
 * Centralized exports for custom React hooks.
 */

export { useKeyboardShortcuts } from "./useKeyboardShortcuts";

export { DEFAULT_PREFERENCES, type ViewType, type ViewPreferences } from "./viewPreferences";

export { useUrlViewPreferences, parseViewPreferencesFromParams } from "./useUrlViewPreferences";

export { useEntryMutations, type EntryType, type MarkAllReadOptions } from "./useEntryMutations";

export { useEntryUrlState } from "./useEntryUrlState";

export { useExpandedTags } from "./useExpandedTags";

export { useEntryListQuery, type EntryListData } from "./useEntryListQuery";

export { useEntriesListInput } from "./useEntriesListInput";

export { useShowOriginalPreference } from "./useShowOriginalPreference";

export { useEntryPage, type UseEntryPageOptions, type UseEntryPageResult } from "./useEntryPage";

export { useImagePrefetch } from "./useImagePrefetch";

export {
  useInfiniteScrollConfig,
  type InfiniteScrollConfig,
  type UseInfiniteScrollConfigOptions,
} from "./useInfiniteScrollConfig";

export { useFormMessages } from "./useFormMessages";
