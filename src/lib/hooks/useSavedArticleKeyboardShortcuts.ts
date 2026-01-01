/**
 * useSavedArticleKeyboardShortcuts Hook
 *
 * Provides keyboard navigation for saved article lists.
 * Similar to useKeyboardShortcuts but adapted for saved articles.
 *
 * Features:
 * - j/k navigation (next/previous article in list, or navigate between articles when viewing)
 * - o/Enter to open selected article
 * - Escape to close article or deselect
 * - m to toggle read/unread
 * - s to toggle star
 * - v to open original URL in new tab
 * - r to refresh current view
 * - u to toggle unread-only filter
 * - g+a to navigate to All items
 * - g+s to navigate to Starred items
 * - g+l to navigate to Saved/Later items
 * - Selected article state management
 */

"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import { useHotkeys } from "react-hotkeys-hook";
import { useRouter } from "next/navigation";

/**
 * Article data needed for keyboard actions.
 */
export interface SavedArticleKeyboardData {
  id: string;
  url: string | null;
  read: boolean;
  starred: boolean;
}

/**
 * Configuration options for keyboard shortcuts.
 */
export interface UseSavedArticleKeyboardShortcutsOptions {
  /**
   * Array of articles in the current list (in display order).
   * Used for navigation and action context.
   */
  articles: SavedArticleKeyboardData[];

  /**
   * Callback when an article should be opened.
   */
  onOpenArticle?: (articleId: string) => void;

  /**
   * Callback when the current view should be closed (e.g., close article content).
   */
  onClose?: () => void;

  /**
   * Whether an article is currently open (viewing content).
   * When true, navigation keys may behave differently.
   */
  isArticleOpen?: boolean;

  /**
   * Whether keyboard shortcuts are enabled.
   * @default true
   */
  enabled?: boolean;

  /**
   * Callback when read status should be toggled.
   * Receives the article ID and its current read status.
   */
  onToggleRead?: (articleId: string, currentlyRead: boolean) => void;

  /**
   * Callback when star status should be toggled.
   * Receives the article ID and its current starred status.
   */
  onToggleStar?: (articleId: string, currentlyStarred: boolean) => void;

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
 * Result returned by the useSavedArticleKeyboardShortcuts hook.
 */
export interface UseSavedArticleKeyboardShortcutsResult {
  /**
   * Currently selected article ID (for visual highlighting).
   * This is separate from the "open" article.
   */
  selectedArticleId: string | null;

  /**
   * Manually set the selected article.
   * Useful for syncing with mouse clicks.
   */
  setSelectedArticleId: (id: string | null) => void;

  /**
   * Move selection to the next article.
   */
  selectNext: () => void;

  /**
   * Move selection to the previous article.
   */
  selectPrevious: () => void;

  /**
   * Open the currently selected article.
   */
  openSelected: () => void;

  /**
   * Clear selection.
   */
  clearSelection: () => void;

  /**
   * Navigate to and open the next article.
   * Used for swipe gestures and keyboard navigation when viewing an article.
   */
  goToNextArticle: () => void;

  /**
   * Navigate to and open the previous article.
   * Used for swipe gestures and keyboard navigation when viewing an article.
   */
  goToPreviousArticle: () => void;
}

/**
 * Hook for keyboard navigation in saved article lists.
 */
export function useSavedArticleKeyboardShortcuts(
  options: UseSavedArticleKeyboardShortcutsOptions
): UseSavedArticleKeyboardShortcutsResult {
  const {
    articles,
    onOpenArticle,
    onClose,
    isArticleOpen = false,
    enabled = true,
    onToggleRead,
    onToggleStar,
    onRefresh,
    onToggleUnreadOnly,
  } = options;

  const router = useRouter();
  const [selectedArticleId, setSelectedArticleId] = useState<string | null>(null);

  // Track "g" prefix for navigation shortcuts (g+a, g+s, g+l)
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

  // Get article IDs from articles
  const articleIds = articles.map((a) => a.id);

  // Get the current index of the selected article
  const getSelectedIndex = useCallback((): number => {
    if (!selectedArticleId) return -1;
    return articleIds.indexOf(selectedArticleId);
  }, [selectedArticleId, articleIds]);

  // Get the selected article data
  const getSelectedArticle = useCallback((): SavedArticleKeyboardData | null => {
    if (!selectedArticleId) return null;
    return articles.find((a) => a.id === selectedArticleId) ?? null;
  }, [selectedArticleId, articles]);

  // Move selection to the next article
  const selectNext = useCallback(() => {
    if (articleIds.length === 0) return;

    const currentIndex = getSelectedIndex();

    if (currentIndex === -1) {
      // Nothing selected, select the first article
      setSelectedArticleId(articleIds[0]);
    } else if (currentIndex < articleIds.length - 1) {
      // Move to next article
      setSelectedArticleId(articleIds[currentIndex + 1]);
    }
    // If already at the last article, do nothing
  }, [articleIds, getSelectedIndex]);

  // Move selection to the previous article
  const selectPrevious = useCallback(() => {
    if (articleIds.length === 0) return;

    const currentIndex = getSelectedIndex();

    if (currentIndex === -1) {
      // Nothing selected, select the last article
      setSelectedArticleId(articleIds[articleIds.length - 1]);
    } else if (currentIndex > 0) {
      // Move to previous article
      setSelectedArticleId(articleIds[currentIndex - 1]);
    }
    // If already at the first article, do nothing
  }, [articleIds, getSelectedIndex]);

  // Navigate to and open the next article (for use when viewing an article)
  const goToNextArticle = useCallback(() => {
    if (articleIds.length === 0 || !onOpenArticle) return;

    const currentIndex = getSelectedIndex();

    if (currentIndex === -1) {
      // Nothing selected, go to the first article
      const nextId = articleIds[0];
      setSelectedArticleId(nextId);
      onOpenArticle(nextId);
    } else if (currentIndex < articleIds.length - 1) {
      // Go to next article
      const nextId = articleIds[currentIndex + 1];
      setSelectedArticleId(nextId);
      onOpenArticle(nextId);
    }
    // If already at the last article, do nothing
  }, [articleIds, getSelectedIndex, onOpenArticle]);

  // Navigate to and open the previous article (for use when viewing an article)
  const goToPreviousArticle = useCallback(() => {
    if (articleIds.length === 0 || !onOpenArticle) return;

    const currentIndex = getSelectedIndex();

    if (currentIndex === -1) {
      // Nothing selected, go to the last article
      const prevId = articleIds[articleIds.length - 1];
      setSelectedArticleId(prevId);
      onOpenArticle(prevId);
    } else if (currentIndex > 0) {
      // Go to previous article
      const prevId = articleIds[currentIndex - 1];
      setSelectedArticleId(prevId);
      onOpenArticle(prevId);
    }
    // If already at the first article, do nothing
  }, [articleIds, getSelectedIndex, onOpenArticle]);

  // Open the currently selected article
  const openSelected = useCallback(() => {
    if (selectedArticleId && onOpenArticle) {
      onOpenArticle(selectedArticleId);
    }
  }, [selectedArticleId, onOpenArticle]);

  // Clear selection
  const clearSelection = useCallback(() => {
    setSelectedArticleId(null);
  }, []);

  // Compute whether the selected article is still in the list
  // If not, we use null instead. This avoids setting state in an effect.
  const isSelectedArticleValid =
    selectedArticleId === null || articleIds.includes(selectedArticleId);
  const effectiveSelectedArticleId = isSelectedArticleValid ? selectedArticleId : null;

  // Scroll selected article into view
  useEffect(() => {
    if (effectiveSelectedArticleId) {
      // Use a small delay to ensure the DOM has updated
      const timeoutId = setTimeout(() => {
        const element = document.querySelector(`[data-entry-id="${effectiveSelectedArticleId}"]`);
        if (element) {
          element.scrollIntoView({
            behavior: "smooth",
            block: "nearest",
          });
        }
      }, 0);

      return () => clearTimeout(timeoutId);
    }
  }, [effectiveSelectedArticleId]);

  // Keyboard shortcuts
  // j - next article (select in list, or navigate to next when viewing)
  useHotkeys(
    "j",
    (e) => {
      e.preventDefault();
      if (isArticleOpen) {
        goToNextArticle();
      } else {
        selectNext();
      }
    },
    {
      enabled: enabled,
      enableOnFormTags: false,
    },
    [selectNext, goToNextArticle, isArticleOpen, enabled]
  );

  // k - previous article (select in list, or navigate to previous when viewing)
  useHotkeys(
    "k",
    (e) => {
      e.preventDefault();
      if (isArticleOpen) {
        goToPreviousArticle();
      } else {
        selectPrevious();
      }
    },
    {
      enabled: enabled,
      enableOnFormTags: false,
    },
    [selectPrevious, goToPreviousArticle, isArticleOpen, enabled]
  );

  // o - open selected article (only when article is not open)
  useHotkeys(
    "o",
    (e) => {
      e.preventDefault();
      openSelected();
    },
    {
      enabled: enabled && !isArticleOpen && !!effectiveSelectedArticleId,
      enableOnFormTags: false,
    },
    [openSelected, isArticleOpen, effectiveSelectedArticleId, enabled]
  );

  // Enter - open selected article (only when article is not open)
  useHotkeys(
    "enter",
    (e) => {
      e.preventDefault();
      openSelected();
    },
    {
      enabled: enabled && !isArticleOpen && !!effectiveSelectedArticleId,
      enableOnFormTags: false,
    },
    [openSelected, isArticleOpen, effectiveSelectedArticleId, enabled]
  );

  // Escape - close article or deselect
  useHotkeys(
    "escape",
    (e) => {
      e.preventDefault();
      if (isArticleOpen && onClose) {
        onClose();
      } else if (effectiveSelectedArticleId) {
        clearSelection();
      }
    },
    {
      enabled: enabled && (isArticleOpen || !!effectiveSelectedArticleId),
      enableOnFormTags: false,
    },
    [isArticleOpen, onClose, effectiveSelectedArticleId, clearSelection, enabled]
  );

  // m - toggle read/unread (when article is selected and not open)
  useHotkeys(
    "m",
    (e) => {
      e.preventDefault();
      const article = getSelectedArticle();
      if (article && onToggleRead) {
        onToggleRead(article.id, article.read);
      }
    },
    {
      enabled: enabled && !isArticleOpen && !!effectiveSelectedArticleId && !!onToggleRead,
      enableOnFormTags: false,
    },
    [getSelectedArticle, onToggleRead, isArticleOpen, effectiveSelectedArticleId, enabled]
  );

  // s - toggle star (when article is selected, not open, and g prefix NOT active)
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
      const article = getSelectedArticle();
      if (article && onToggleStar) {
        onToggleStar(article.id, article.starred);
      }
    },
    {
      enabled: enabled && !isArticleOpen && (!!effectiveSelectedArticleId || gPrefixActive),
      enableOnFormTags: false,
    },
    [
      getSelectedArticle,
      onToggleStar,
      isArticleOpen,
      effectiveSelectedArticleId,
      enabled,
      gPrefixActive,
      clearGPrefix,
      router,
    ]
  );

  // v - open original URL in new tab (when article is selected)
  useHotkeys(
    "v",
    (e) => {
      e.preventDefault();
      const article = getSelectedArticle();
      if (article?.url) {
        window.open(article.url, "_blank", "noopener,noreferrer");
      }
    },
    {
      enabled: enabled && !isArticleOpen && !!effectiveSelectedArticleId,
      enableOnFormTags: false,
    },
    [getSelectedArticle, isArticleOpen, effectiveSelectedArticleId, enabled]
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
      enabled: enabled && !isArticleOpen && !!onRefresh,
      enableOnFormTags: false,
    },
    [onRefresh, isArticleOpen, enabled]
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
      enabled: enabled && !isArticleOpen && !!onToggleUnreadOnly,
      enableOnFormTags: false,
    },
    [onToggleUnreadOnly, isArticleOpen, enabled]
  );

  // g - activate g prefix for navigation shortcuts
  useHotkeys(
    "g",
    (e) => {
      e.preventDefault();
      activateGPrefix();
    },
    {
      enabled: enabled && !isArticleOpen,
      enableOnFormTags: false,
    },
    [activateGPrefix, isArticleOpen, enabled]
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
      enabled: enabled && !isArticleOpen && gPrefixActive,
      enableOnFormTags: false,
    },
    [gPrefixActive, clearGPrefix, router, isArticleOpen, enabled]
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
      enabled: enabled && !isArticleOpen && gPrefixActive,
      enableOnFormTags: false,
    },
    [gPrefixActive, clearGPrefix, router, isArticleOpen, enabled]
  );

  return {
    selectedArticleId: effectiveSelectedArticleId,
    setSelectedArticleId,
    selectNext,
    selectPrevious,
    openSelected,
    clearSelection,
    goToNextArticle,
    goToPreviousArticle,
  };
}
