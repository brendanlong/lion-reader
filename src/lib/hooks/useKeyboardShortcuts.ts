/**
 * useKeyboardShortcuts Hook
 *
 * Binds the entry-list shortcuts from the shared table
 * (`@/components/keyboard/shortcuts`) and manages the keyboard selection.
 */

"use client";

import { useState, useCallback, useRef } from "react";
import { useHotkeys } from "react-hotkeys-hook";
import { clientPush } from "@/lib/navigation";
import { useAppHref } from "./useAppLocation";
import { goToSidebarFeed } from "@/components/layout/sidebar-feed-navigation";
import {
  SHORTCUTS,
  hotkeyAlternatives,
  type ShortcutDefinition,
  type ShortcutId,
} from "@/components/keyboard/shortcuts";
import type { EntryType } from "@/lib/entry-types";

/**
 * How long a prefix key ("g") waits for the second key of its chord.
 * @testonly
 */
export const PREFIX_TIMEOUT_MS = 1500;

/** The table shortcuts this hook binds. */
const LIST_SHORTCUT_IDS = [
  "nextEntry",
  "previousEntry",
  "openEntry",
  "closeEntry",
  "nextFeed",
  "previousFeed",
  "goToAll",
  "goToStarred",
  "goToSaved",
  "toggleRead",
  "toggleStar",
  "toggleUnreadOnly",
  "openOriginal",
  "refresh",
] as const satisfies readonly ShortcutId[];

type ListShortcutId = (typeof LIST_SHORTCUT_IDS)[number];

const LIST_SHORTCUTS: [ListShortcutId, ShortcutDefinition][] = LIST_SHORTCUT_IDS.map((id) => [
  id,
  SHORTCUTS[id],
]);

/** Every key the hook listens for: each shortcut's alternatives plus the prefix keys. */
const LIST_HOTKEYS = [
  ...new Set(
    LIST_SHORTCUTS.flatMap(([, shortcut]) => [
      ...hotkeyAlternatives(shortcut.hotkey),
      ...(shortcut.prefix ? [shortcut.prefix] : []),
    ])
  ),
].join(",");

interface ShortcutAction {
  enabled: boolean;
  run: () => void;
}

/**
 * Entry data needed for keyboard actions.
 */
export interface KeyboardEntryData {
  id: string;
  url: string | null;
  read: boolean;
  starred: boolean;
  subscriptionId?: string | null;
  type: EntryType;
}

/**
 * Configuration options for keyboard shortcuts.
 */
export interface UseKeyboardShortcutsOptions {
  /**
   * Array of entries in the current list (in display order).
   * Used for navigation and action context.
   */
  entries: KeyboardEntryData[];

  /**
   * Callback when an entry should be opened.
   */
  onOpenEntry: (entryId: string) => void;

  /**
   * Callback when the current view should be closed (e.g., close entry content).
   */
  onClose: () => void;

  /**
   * The currently open entry ID, or null when none is open. While an entry is
   * open, j/k navigate between entries and the list selection follows it.
   */
  openEntryId: string | null;

  /**
   * Whether keyboard shortcuts are enabled.
   */
  enabled: boolean;

  /**
   * Callback when read status should be toggled.
   * Receives the entry ID and its current read status.
   */
  onToggleRead: (entryId: string, currentlyRead: boolean) => void;

  /**
   * Callback when star status should be toggled.
   * Receives the entry ID and its current starred status.
   */
  onToggleStar: (entryId: string, currentlyStarred: boolean) => void;

  /**
   * Callback to refresh the current view.
   */
  onRefresh: () => void;

  /**
   * Callback to toggle unread-only filter.
   */
  onToggleUnreadOnly: () => void;

  /**
   * Callback when user presses j to navigate to next entry (while viewing).
   * The parent computes the next entry ID from the entries list.
   */
  onNavigateNext: () => void;

  /**
   * Callback when user presses k to navigate to previous entry (while viewing).
   * The parent computes the previous entry ID from the entries list.
   */
  onNavigatePrevious: () => void;
}

/**
 * Result returned by the useKeyboardShortcuts hook.
 */
export interface UseKeyboardShortcutsResult {
  /**
   * Currently selected entry ID (for visual highlighting).
   * This is separate from the "open" entry.
   */
  selectedEntryId: string | null;

  /**
   * Manually set the selected entry.
   * Useful for syncing with mouse clicks.
   */
  setSelectedEntryId: (id: string | null) => void;
}

/**
 * Hook for keyboard navigation in entry lists.
 *
 * @example
 * ```tsx
 * function EntryListPage() {
 *   const { openEntryId, setOpenEntryId, closeEntry } = useEntryUrlState();
 *
 *   const {
 *     selectedEntryId,
 *     setSelectedEntryId,
 *   } = useKeyboardShortcuts({
 *     entries,
 *     onOpenEntry: setOpenEntryId,
 *     onClose: closeEntry,
 *     openEntryId,
 *     enabled: true,
 *     onToggleRead: (id, read) => markReadMutation.mutate({ ids: [id], read: !read }),
 *     onToggleStar: (id, starred) => starred ? unstarMutation.mutate({ id }) : starMutation.mutate({ id }),
 *     onRefresh: () => refreshEntryLists(queryClient),
 *     onToggleUnreadOnly,
 *     onNavigateNext,
 *     onNavigatePrevious,
 *   });
 *
 *   return (
 *     <EntryList
 *       selectedEntryId={selectedEntryId}
 *       onEntryClick={(id) => {
 *         setSelectedEntryId(id);
 *         setOpenEntryId(id);
 *       }}
 *     />
 *   );
 * }
 * ```
 */
export function useKeyboardShortcuts(
  options: UseKeyboardShortcutsOptions
): UseKeyboardShortcutsResult {
  const appHref = useAppHref();
  const {
    entries,
    onOpenEntry,
    onClose,
    openEntryId,
    enabled,
    onToggleRead,
    onToggleStar,
    onRefresh,
    onToggleUnreadOnly,
    onNavigateNext,
    onNavigatePrevious,
  } = options;
  const isEntryOpen = !!openEntryId;

  // Internal state for selection when not viewing an entry
  const [internalSelectedEntryId, setInternalSelectedEntryId] = useState<string | null>(null);

  // While an entry is open the selection follows it (j/k navigation and swipes
  // while viewing), derived during render rather than synced by an effect to
  // avoid cascading renders; otherwise it's the internal selection.
  const selectedEntryId = openEntryId || internalSelectedEntryId;

  // Simple setter - updates internal state
  const setSelectedEntryId = useCallback((id: string | null) => {
    setInternalSelectedEntryId(id);
  }, []);

  // The prefix key pressed and when its chord expires. A ref, not state: only
  // the next keydown reads it.
  const pendingPrefixRef = useRef<{ key: string; expiresAt: number } | null>(null);

  const entryIds = entries.map((e) => e.id);

  // Move browser focus onto a list row. Selection is shown by the shared
  // `:focus-visible` outline (the selected row is the focused row), so j/k must
  // actually focus the row — that unifies the keyboard cursor with Tab focus
  // onto one indicator instead of a separate ring. The row already exists in the
  // DOM (the list isn't virtualized), so this resolves synchronously; focusing
  // also scrolls it into view. `onFocus` on the row keeps selectedEntryId in
  // sync, so this and setSelectedEntryId agree.
  const focusEntryRow = (id: string) => {
    if (typeof document === "undefined") return;
    document.querySelector<HTMLElement>(`[data-entry-id="${id}"]`)?.focus();
  };

  const getSelectedEntry = (): KeyboardEntryData | null => {
    if (!selectedEntryId) return null;
    return entries.find((e) => e.id === selectedEntryId) ?? null;
  };

  // With nothing selected, moving forward selects the first entry and moving
  // back the last; at either end of the list it stays put.
  const moveSelection = (direction: 1 | -1) => {
    const currentIndex = selectedEntryId ? entryIds.indexOf(selectedEntryId) : -1;
    const targetId =
      currentIndex === -1
        ? entryIds[direction === 1 ? 0 : entryIds.length - 1]
        : entryIds[currentIndex + direction];
    if (targetId) {
      setSelectedEntryId(targetId);
      focusEntryRow(targetId);
    }
  };

  const openSelected = () => {
    if (selectedEntryId) onOpenEntry(selectedEntryId);
  };

  const clearSelection = () => {
    setSelectedEntryId(null);
    // Selection is shown by the focused row's outline, so clearing it (Escape)
    // must also drop focus from that row — otherwise the outline would linger
    // with nothing logically selected.
    if (typeof document !== "undefined") {
      const active = document.activeElement;
      if (active instanceof HTMLElement && active.matches("[data-entry-id]")) {
        active.blur();
      }
    }
  };

  // Compute whether the selected entry is still in the list
  // If not, we use null instead. This avoids setting state in an effect.
  const isSelectedEntryValid = selectedEntryId === null || entryIds.includes(selectedEntryId);
  const effectiveSelectedEntryId = isSelectedEntryValid ? selectedEntryId : null;

  const hasSelection = !!effectiveSelectedEntryId;
  const onSelectedEntry = (run: (entry: KeyboardEntryData) => void): ShortcutAction => ({
    enabled: !isEntryOpen && hasSelection,
    run: () => {
      const entry = getSelectedEntry();
      if (entry) run(entry);
    },
  });
  const goTo = (path: string): ShortcutAction => ({
    enabled: !isEntryOpen,
    run: () => clientPush(appHref(path)),
  });

  const actions: Record<ListShortcutId, ShortcutAction> = {
    nextEntry: { enabled: true, run: isEntryOpen ? onNavigateNext : () => moveSelection(1) },
    previousEntry: {
      enabled: true,
      run: isEntryOpen ? onNavigatePrevious : () => moveSelection(-1),
    },
    openEntry: { enabled: !isEntryOpen && hasSelection, run: openSelected },
    closeEntry: {
      enabled: isEntryOpen || hasSelection,
      run: isEntryOpen ? onClose : clearSelection,
    },
    nextFeed: { enabled: true, run: () => goToSidebarFeed(1) },
    previousFeed: { enabled: true, run: () => goToSidebarFeed(-1) },
    goToAll: goTo("/all"),
    goToStarred: goTo("/starred"),
    goToSaved: goTo("/saved"),
    toggleRead: onSelectedEntry((entry) => onToggleRead(entry.id, entry.read)),
    toggleStar: onSelectedEntry((entry) => onToggleStar(entry.id, entry.starred)),
    openOriginal: onSelectedEntry((entry) => {
      if (entry.url) window.open(entry.url, "_blank", "noopener,noreferrer");
    }),
    refresh: { enabled: !isEntryOpen, run: onRefresh },
    toggleUnreadOnly: { enabled: !isEntryOpen, run: onToggleUnreadOnly },
  };

  const findAction = (hotkey: string, prefix: string | undefined): ShortcutAction | undefined => {
    const match = LIST_SHORTCUTS.find(
      ([id, shortcut]) =>
        shortcut.prefix === prefix &&
        hotkeyAlternatives(shortcut.hotkey).includes(hotkey) &&
        actions[id].enabled
    );
    return match && actions[match[0]];
  };

  // One binding for the whole table, dispatched on the alternative that
  // matched. No deps array: react-hotkeys-hook then calls the latest callback.
  useHotkeys(
    LIST_HOTKEYS,
    (e, { hotkey }) => {
      const pending = pendingPrefixRef.current;
      const prefix = pending && Date.now() < pending.expiresAt ? pending.key : undefined;

      // The second key of a chord wins over its own binding (g then s goes to
      // Starred rather than starring).
      const chord = prefix === undefined ? undefined : findAction(hotkey, prefix);
      if (chord) {
        e.preventDefault();
        pendingPrefixRef.current = null;
        chord.run();
        return;
      }

      const startsChord = LIST_SHORTCUTS.some(
        ([id, shortcut]) => shortcut.prefix === hotkey && actions[id].enabled
      );
      if (startsChord) {
        e.preventDefault();
        pendingPrefixRef.current = { key: hotkey, expiresAt: Date.now() + PREFIX_TIMEOUT_MS };
        return;
      }

      const action = findAction(hotkey, undefined);
      if (action) {
        e.preventDefault();
        action.run();
      }
    },
    { enabled, enableOnFormTags: false }
  );

  return {
    selectedEntryId: effectiveSelectedEntryId,
    setSelectedEntryId,
  };
}
