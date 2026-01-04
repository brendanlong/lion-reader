/**
 * useKeyboardShortcuts Hook
 *
 * Provides keyboard navigation for entry lists.
 * Uses react-hotkeys-hook for keyboard event handling.
 *
 * Features:
 * - j/k navigation (next/previous entry in list, or navigate between entries when viewing)
 * - o/Enter to open selected entry
 * - Escape to close entry or deselect
 * - m to toggle read/unread
 * - s to toggle star
 * - v to open original URL in new tab
 * - r to refresh current view
 * - u to toggle unread-only filter
 * - g+a to navigate to All items
 * - g+s to navigate to Starred items
 * - g+l to navigate to Saved/Later items
 * - Selected entry state management
 */

"use client";

import { useState, useCallback, useEffect, useLayoutEffect, useRef } from "react";
import { useHotkeys } from "react-hotkeys-hook";
import { useRouter } from "next/navigation";

/**
 * Entry data needed for keyboard actions.
 */
export interface KeyboardEntryData {
  id: string;
  url: string | null;
  read: boolean;
  starred: boolean;
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
  onOpenEntry?: (entryId: string) => void;

  /**
   * Callback when the current view should be closed (e.g., close entry content).
   */
  onClose?: () => void;

  /**
   * Whether an entry is currently open (viewing content).
   * When true, navigation keys may behave differently.
   */
  isEntryOpen?: boolean;

  /**
   * Whether keyboard shortcuts are enabled.
   * @default true
   */
  enabled?: boolean;

  /**
   * Callback when read status should be toggled.
   * Receives the entry ID and its current read status.
   */
  onToggleRead?: (entryId: string, currentlyRead: boolean) => void;

  /**
   * Callback when star status should be toggled.
   * Receives the entry ID and its current starred status.
   */
  onToggleStar?: (entryId: string, currentlyStarred: boolean) => void;

  /**
   * Callback to refresh the current view.
   */
  onRefresh?: () => void;

  /**
   * Callback to toggle unread-only filter.
   */
  onToggleUnreadOnly?: () => void;
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

  /**
   * Move selection to the next entry.
   */
  selectNext: () => void;

  /**
   * Move selection to the previous entry.
   */
  selectPrevious: () => void;

  /**
   * Open the currently selected entry.
   */
  openSelected: () => void;

  /**
   * Clear selection.
   */
  clearSelection: () => void;

  /**
   * Navigate to and open the next entry.
   * Used for swipe gestures and keyboard navigation when viewing an entry.
   */
  goToNextEntry: () => void;

  /**
   * Navigate to and open the previous entry.
   * Used for swipe gestures and keyboard navigation when viewing an entry.
   */
  goToPreviousEntry: () => void;
}

/**
 * Hook for keyboard navigation in entry lists.
 *
 * @example
 * ```tsx
 * function EntryListPage() {
 *   const [openEntryId, setOpenEntryId] = useState<string | null>(null);
 *
 *   const {
 *     selectedEntryId,
 *     setSelectedEntryId,
 *   } = useKeyboardShortcuts({
 *     entries,
 *     onOpenEntry: setOpenEntryId,
 *     onClose: () => setOpenEntryId(null),
 *     isEntryOpen: !!openEntryId,
 *     onToggleRead: (id, read) => markReadMutation.mutate({ ids: [id], read: !read }),
 *     onToggleStar: (id, starred) => starred ? unstarMutation.mutate({ id }) : starMutation.mutate({ id }),
 *     onRefresh: () => utils.entries.list.invalidate(),
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
  const {
    entries,
    onOpenEntry,
    onClose,
    isEntryOpen = false,
    enabled = true,
    onToggleRead,
    onToggleStar,
    onRefresh,
    onToggleUnreadOnly,
  } = options;

  const router = useRouter();
  const [selectedEntryId, setSelectedEntryId] = useState<string | null>(null);

  // Track "g" prefix for navigation shortcuts (g+a, g+s)
  const gPrefixTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [gPrefixActive, setGPrefixActive] = useState(false);

  // Clear g prefix after timeout
  const clearGPrefix = useCallback(() => {
    if (gPrefixTimeoutRef.current) {
      clearTimeout(gPrefixTimeoutRef.current);
      gPrefixTimeoutRef.current = null;
    }
    setGPrefixActive(false);
  }, []);

  // Activate g prefix with timeout
  const activateGPrefix = useCallback(() => {
    clearGPrefix();
    setGPrefixActive(true);
    gPrefixTimeoutRef.current = setTimeout(() => {
      setGPrefixActive(false);
    }, 1500); // 1.5 second timeout for the second key
  }, [clearGPrefix]);

  // Cleanup timeout on unmount
  useEffect(() => {
    return () => {
      if (gPrefixTimeoutRef.current) {
        clearTimeout(gPrefixTimeoutRef.current);
      }
    };
  }, []);

  // Get entry IDs from entries
  const entryIds = entries.map((e) => e.id);

  // Get the current index of the selected entry
  const getSelectedIndex = useCallback((): number => {
    if (!selectedEntryId) return -1;
    return entryIds.indexOf(selectedEntryId);
  }, [selectedEntryId, entryIds]);

  // Get the selected entry data
  const getSelectedEntry = useCallback((): KeyboardEntryData | null => {
    if (!selectedEntryId) return null;
    return entries.find((e) => e.id === selectedEntryId) ?? null;
  }, [selectedEntryId, entries]);

  // Move selection to the next entry
  const selectNext = useCallback(() => {
    if (entryIds.length === 0) return;

    const currentIndex = getSelectedIndex();

    if (currentIndex === -1) {
      // Nothing selected, select the first entry
      setSelectedEntryId(entryIds[0]);
    } else if (currentIndex < entryIds.length - 1) {
      // Move to next entry
      setSelectedEntryId(entryIds[currentIndex + 1]);
    }
    // If already at the last entry, do nothing
  }, [entryIds, getSelectedIndex]);

  // Move selection to the previous entry
  const selectPrevious = useCallback(() => {
    if (entryIds.length === 0) return;

    const currentIndex = getSelectedIndex();

    if (currentIndex === -1) {
      // Nothing selected, select the last entry
      setSelectedEntryId(entryIds[entryIds.length - 1]);
    } else if (currentIndex > 0) {
      // Move to previous entry
      setSelectedEntryId(entryIds[currentIndex - 1]);
    }
    // If already at the first entry, do nothing
  }, [entryIds, getSelectedIndex]);

  // Navigate to and open the next entry (for use when viewing an entry)
  const goToNextEntry = useCallback(() => {
    if (entryIds.length === 0 || !onOpenEntry) return;

    const currentIndex = getSelectedIndex();

    if (currentIndex === -1) {
      // Nothing selected, go to the first entry
      const nextId = entryIds[0];
      setSelectedEntryId(nextId);
      onOpenEntry(nextId);
    } else if (currentIndex < entryIds.length - 1) {
      // Go to next entry
      const nextId = entryIds[currentIndex + 1];
      setSelectedEntryId(nextId);
      onOpenEntry(nextId);
    }
    // If already at the last entry, do nothing
  }, [entryIds, getSelectedIndex, onOpenEntry]);

  // Navigate to and open the previous entry (for use when viewing an entry)
  const goToPreviousEntry = useCallback(() => {
    if (entryIds.length === 0 || !onOpenEntry) return;

    const currentIndex = getSelectedIndex();

    if (currentIndex === -1) {
      // Nothing selected, go to the last entry
      const prevId = entryIds[entryIds.length - 1];
      setSelectedEntryId(prevId);
      onOpenEntry(prevId);
    } else if (currentIndex > 0) {
      // Go to previous entry
      const prevId = entryIds[currentIndex - 1];
      setSelectedEntryId(prevId);
      onOpenEntry(prevId);
    }
    // If already at the first entry, do nothing
  }, [entryIds, getSelectedIndex, onOpenEntry]);

  // Open the currently selected entry
  const openSelected = useCallback(() => {
    if (selectedEntryId && onOpenEntry) {
      onOpenEntry(selectedEntryId);
    }
  }, [selectedEntryId, onOpenEntry]);

  // Clear selection
  const clearSelection = useCallback(() => {
    setSelectedEntryId(null);
  }, []);

  // Compute whether the selected entry is still in the list
  // If not, we use null instead. This avoids setting state in an effect.
  const isSelectedEntryValid = selectedEntryId === null || entryIds.includes(selectedEntryId);
  const effectiveSelectedEntryId = isSelectedEntryValid ? selectedEntryId : null;

  // Scroll selected entry into view using useLayoutEffect to ensure DOM is ready
  useLayoutEffect(() => {
    if (effectiveSelectedEntryId) {
      const element = document.querySelector(`[data-entry-id="${effectiveSelectedEntryId}"]`);
      if (element) {
        element.scrollIntoView({
          behavior: "smooth",
          block: "nearest",
        });
      }
    }
  }, [effectiveSelectedEntryId]);

  // Keyboard shortcuts
  // j - next entry (select in list, or navigate to next when viewing)
  useHotkeys(
    "j",
    (e) => {
      e.preventDefault();
      if (isEntryOpen) {
        goToNextEntry();
      } else {
        selectNext();
      }
    },
    {
      enabled: enabled,
      enableOnFormTags: false,
    },
    [selectNext, goToNextEntry, isEntryOpen, enabled]
  );

  // k - previous entry (select in list, or navigate to previous when viewing)
  useHotkeys(
    "k",
    (e) => {
      e.preventDefault();
      if (isEntryOpen) {
        goToPreviousEntry();
      } else {
        selectPrevious();
      }
    },
    {
      enabled: enabled,
      enableOnFormTags: false,
    },
    [selectPrevious, goToPreviousEntry, isEntryOpen, enabled]
  );

  // o - open selected entry (only when entry is not open)
  useHotkeys(
    "o",
    (e) => {
      e.preventDefault();
      openSelected();
    },
    {
      enabled: enabled && !isEntryOpen && !!effectiveSelectedEntryId,
      enableOnFormTags: false,
    },
    [openSelected, isEntryOpen, effectiveSelectedEntryId, enabled]
  );

  // Enter - open selected entry (only when entry is not open)
  useHotkeys(
    "enter",
    (e) => {
      e.preventDefault();
      openSelected();
    },
    {
      enabled: enabled && !isEntryOpen && !!effectiveSelectedEntryId,
      enableOnFormTags: false,
    },
    [openSelected, isEntryOpen, effectiveSelectedEntryId, enabled]
  );

  // Escape - close entry or deselect
  useHotkeys(
    "escape",
    (e) => {
      e.preventDefault();
      if (isEntryOpen && onClose) {
        onClose();
      } else if (effectiveSelectedEntryId) {
        clearSelection();
      }
    },
    {
      enabled: enabled && (isEntryOpen || !!effectiveSelectedEntryId),
      enableOnFormTags: false,
    },
    [isEntryOpen, onClose, effectiveSelectedEntryId, clearSelection, enabled]
  );

  // m - toggle read/unread (when entry is selected and not open)
  useHotkeys(
    "m",
    (e) => {
      e.preventDefault();
      const entry = getSelectedEntry();
      if (entry && onToggleRead) {
        onToggleRead(entry.id, entry.read);
      }
    },
    {
      enabled: enabled && !isEntryOpen && !!effectiveSelectedEntryId && !!onToggleRead,
      enableOnFormTags: false,
    },
    [getSelectedEntry, onToggleRead, isEntryOpen, effectiveSelectedEntryId, enabled]
  );

  // s - toggle star (when entry is selected, not open, and g prefix NOT active)
  useHotkeys(
    "s",
    (e) => {
      // If g prefix is active, this should trigger navigation instead
      if (gPrefixActive) {
        e.preventDefault();
        clearGPrefix();
        router.push("/starred");
        return;
      }

      e.preventDefault();
      const entry = getSelectedEntry();
      if (entry && onToggleStar) {
        onToggleStar(entry.id, entry.starred);
      }
    },
    {
      enabled: enabled && !isEntryOpen && (!!effectiveSelectedEntryId || gPrefixActive),
      enableOnFormTags: false,
    },
    [
      getSelectedEntry,
      onToggleStar,
      isEntryOpen,
      effectiveSelectedEntryId,
      enabled,
      gPrefixActive,
      clearGPrefix,
      router,
    ]
  );

  // v - open original URL in new tab (when entry is selected)
  useHotkeys(
    "v",
    (e) => {
      e.preventDefault();
      const entry = getSelectedEntry();
      if (entry?.url) {
        window.open(entry.url, "_blank", "noopener,noreferrer");
      }
    },
    {
      enabled: enabled && !isEntryOpen && !!effectiveSelectedEntryId,
      enableOnFormTags: false,
    },
    [getSelectedEntry, isEntryOpen, effectiveSelectedEntryId, enabled]
  );

  // r - refresh current view
  useHotkeys(
    "r",
    (e) => {
      e.preventDefault();
      if (onRefresh) {
        onRefresh();
      }
    },
    {
      enabled: enabled && !isEntryOpen && !!onRefresh,
      enableOnFormTags: false,
    },
    [onRefresh, isEntryOpen, enabled]
  );

  // u - toggle unread-only filter
  useHotkeys(
    "u",
    (e) => {
      e.preventDefault();
      if (onToggleUnreadOnly) {
        onToggleUnreadOnly();
      }
    },
    {
      enabled: enabled && !isEntryOpen && !!onToggleUnreadOnly,
      enableOnFormTags: false,
    },
    [onToggleUnreadOnly, isEntryOpen, enabled]
  );

  // g - activate g prefix for navigation shortcuts
  useHotkeys(
    "g",
    (e) => {
      e.preventDefault();
      activateGPrefix();
    },
    {
      enabled: enabled && !isEntryOpen,
      enableOnFormTags: false,
    },
    [activateGPrefix, isEntryOpen, enabled]
  );

  // a - go to All (when g prefix is active)
  useHotkeys(
    "a",
    (e) => {
      if (!gPrefixActive) return;
      e.preventDefault();
      clearGPrefix();
      router.push("/all");
    },
    {
      enabled: enabled && !isEntryOpen && gPrefixActive,
      enableOnFormTags: false,
    },
    [gPrefixActive, clearGPrefix, router, isEntryOpen, enabled]
  );

  // l - go to Saved/Later (when g prefix is active)
  useHotkeys(
    "l",
    (e) => {
      if (!gPrefixActive) return;
      e.preventDefault();
      clearGPrefix();
      router.push("/saved");
    },
    {
      enabled: enabled && !isEntryOpen && gPrefixActive,
      enableOnFormTags: false,
    },
    [gPrefixActive, clearGPrefix, router, isEntryOpen, enabled]
  );

  return {
    selectedEntryId: effectiveSelectedEntryId,
    setSelectedEntryId,
    selectNext,
    selectPrevious,
    openSelected,
    clearSelection,
    goToNextEntry,
    goToPreviousEntry,
  };
}
