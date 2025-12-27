/**
 * useKeyboardShortcuts Hook
 *
 * Provides keyboard navigation for entry lists.
 * Uses react-hotkeys-hook for keyboard event handling.
 *
 * Features:
 * - j/k navigation (next/previous entry)
 * - o/Enter to open selected entry
 * - Escape to close entry or deselect
 * - Selected entry state management
 */

"use client";

import { useState, useCallback, useEffect } from "react";
import { useHotkeys } from "react-hotkeys-hook";

/**
 * Configuration options for keyboard shortcuts.
 */
export interface UseKeyboardShortcutsOptions {
  /**
   * Array of entry IDs in the current list (in display order).
   */
  entryIds: string[];

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
}

/**
 * Hook for keyboard navigation in entry lists.
 *
 * @example
 * ```tsx
 * function EntryListPage() {
 *   const [openEntryId, setOpenEntryId] = useState<string | null>(null);
 *   const entryIds = entries.map(e => e.id);
 *
 *   const {
 *     selectedEntryId,
 *     setSelectedEntryId,
 *   } = useKeyboardShortcuts({
 *     entryIds,
 *     onOpenEntry: setOpenEntryId,
 *     onClose: () => setOpenEntryId(null),
 *     isEntryOpen: !!openEntryId,
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
  const { entryIds, onOpenEntry, onClose, isEntryOpen = false, enabled = true } = options;

  const [selectedEntryId, setSelectedEntryId] = useState<string | null>(null);

  // Get the current index of the selected entry
  const getSelectedIndex = useCallback((): number => {
    if (!selectedEntryId) return -1;
    return entryIds.indexOf(selectedEntryId);
  }, [selectedEntryId, entryIds]);

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

  // Scroll selected entry into view
  useEffect(() => {
    if (effectiveSelectedEntryId) {
      // Use a small delay to ensure the DOM has updated
      const timeoutId = setTimeout(() => {
        const element = document.querySelector(`[data-entry-id="${effectiveSelectedEntryId}"]`);
        if (element) {
          element.scrollIntoView({
            behavior: "smooth",
            block: "nearest",
          });
        }
      }, 0);

      return () => clearTimeout(timeoutId);
    }
  }, [effectiveSelectedEntryId]);

  // Keyboard shortcuts
  // j - next entry (only when entry is not open)
  useHotkeys(
    "j",
    (e) => {
      e.preventDefault();
      selectNext();
    },
    {
      enabled: enabled && !isEntryOpen,
      enableOnFormTags: false,
    },
    [selectNext, isEntryOpen, enabled]
  );

  // k - previous entry (only when entry is not open)
  useHotkeys(
    "k",
    (e) => {
      e.preventDefault();
      selectPrevious();
    },
    {
      enabled: enabled && !isEntryOpen,
      enableOnFormTags: false,
    },
    [selectPrevious, isEntryOpen, enabled]
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

  return {
    selectedEntryId: effectiveSelectedEntryId,
    setSelectedEntryId,
    selectNext,
    selectPrevious,
    openSelected,
    clearSelection,
  };
}
