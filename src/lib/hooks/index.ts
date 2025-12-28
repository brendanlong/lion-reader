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
  type ViewType,
  type ViewPreferences,
  type UseViewPreferencesResult,
} from "./useViewPreferences";
