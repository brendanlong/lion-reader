/**
 * useEntryPage Hook
 *
 * Consolidates all shared logic for entry list pages.
 * Each page only needs to provide filters and render its unique header UI.
 */

"use client";

import { useCallback, useMemo } from "react";
import { trpc } from "@/lib/trpc/client";
import { useKeyboardShortcutsContext } from "@/components/keyboard";
import { type ExternalQueryState } from "@/components/entries";
import { type EntryType } from "./useEntryMutations";
import { useEntryUrlState } from "./useEntryUrlState";
import { useUrlViewPreferences } from "./useUrlViewPreferences";
import { type ViewType } from "./viewPreferences";
import { useEntryListQuery, type EntryListData } from "./useEntryListQuery";
import { useEntryMutations, type MarkAllReadOptions } from "./useEntryMutations";
import { useKeyboardShortcuts } from "./useKeyboardShortcuts";
import { useInfiniteScrollConfig } from "./useInfiniteScrollConfig";

/**
 * Filter options for the entry page.
 */
export interface EntryPageFilters {
  subscriptionId?: string;
  tagId?: string;
  uncategorized?: boolean;
  starredOnly?: boolean;
  type?: EntryType;
}

/**
 * Options for the useEntryPage hook.
 */
export interface UseEntryPageOptions {
  /**
   * Unique identifier for this view's preferences (e.g., "all", "starred", "saved").
   */
  viewId: ViewType;

  /**
   * Optional scope for view preferences (e.g., subscriptionId, tagId).
   */
  viewScopeId?: string;

  /**
   * Base filters for the entry list query.
   * unreadOnly and sortOrder are added automatically from view preferences.
   */
  filters?: EntryPageFilters;
}

/**
 * Subscription data from the subscriptions.list query.
 */
type SubscriptionItem = {
  id: string;
  unreadCount: number;
  tags: Array<{ id: string }>;
  [key: string]: unknown;
};

/**
 * Result of the useEntryPage hook.
 */
export interface UseEntryPageResult {
  // Entry state
  openEntryId: string | null;
  selectedEntryId: string | null;

  // View preferences
  showUnreadOnly: boolean;
  sortOrder: "newest" | "oldest";
  toggleShowUnreadOnly: () => void;
  toggleSortOrder: () => void;

  // Entries for display
  entries: EntryListData[];

  // Query state
  isLoading: boolean;
  subscriptionsLoading: boolean;
  subscriptions: { items: SubscriptionItem[] } | undefined;

  // Callbacks for EntryList
  handleEntryClick: (entryId: string) => void;
  handleToggleRead: (entryId: string, currentlyRead: boolean) => void;
  handleToggleStar: (entryId: string, currentlyStarred: boolean) => void;

  // Callbacks for EntryContent
  handleBack: () => void;
  goToNextEntry: () => void;
  goToPreviousEntry: () => void;
  nextEntryId?: string;
  previousEntryId?: string;

  // Mark all read
  handleMarkAllRead: (options?: MarkAllReadOptions) => void;
  isMarkAllReadPending: boolean;

  // Props objects for components
  entryListProps: {
    filters: EntryPageFilters & { unreadOnly: boolean; sortOrder: "newest" | "oldest" };
    onEntryClick: (entryId: string) => void;
    selectedEntryId: string | null;
    onToggleRead: (entryId: string, currentlyRead: boolean) => void;
    onToggleStar: (entryId: string, currentlyStarred: boolean) => void;
    externalEntries: EntryListData[];
    externalQueryState: ExternalQueryState;
    rootMargin: string;
  };

  entryContentProps: {
    entryId: string;
    onBack: () => void;
    onSwipeNext: () => void;
    onSwipePrevious: () => void;
    nextEntryId?: string;
    previousEntryId?: string;
  } | null;

  // Utils for custom invalidation
  utils: ReturnType<typeof trpc.useUtils>;
}

/**
 * Hook that provides all shared logic for entry list pages.
 *
 * @example
 * ```tsx
 * function AllEntriesPage() {
 *   const page = useEntryPage({ viewId: "all" });
 *
 *   return (
 *     <>
 *       {page.openEntryId && <EntryContent key={page.openEntryId} {...page.entryContentProps} />}
 *       <div className={page.openEntryId ? "hidden" : ""}>
 *         <h1>All Items</h1>
 *         <EntryList {...page.entryListProps} />
 *       </div>
 *     </>
 *   );
 * }
 * ```
 */
export function useEntryPage(options: UseEntryPageOptions): UseEntryPageResult {
  const { filters = {} } = options;

  const utils = trpc.useUtils();

  // Viewport-based infinite scroll config
  const scrollConfig = useInfiniteScrollConfig();

  // URL state for open entry
  const { openEntryId, setOpenEntryId, closeEntry } = useEntryUrlState();

  // Keyboard shortcuts context
  const { enabled: keyboardShortcutsEnabled } = useKeyboardShortcutsContext();

  // View preferences (unread only, sort order) - synced to URL query params
  const { showUnreadOnly, toggleShowUnreadOnly, sortOrder, toggleSortOrder } =
    useUrlViewPreferences();

  // Combined filters including view preferences
  const combinedFilters = useMemo(
    () => ({
      ...filters,
      unreadOnly: showUnreadOnly,
      sortOrder,
    }),
    [filters, showUnreadOnly, sortOrder]
  );

  // Subscriptions query for tag lookup and placeholder data
  const subscriptionsQuery = trpc.subscriptions.list.useQuery();

  // Entry list query
  const entryListQuery = useEntryListQuery({
    filters: combinedFilters,
    openEntryId,
    // Pass subscriptions for tag filtering in placeholder data
    subscriptions: subscriptionsQuery.data?.items,
  });

  // Use entries directly from query (no delta merging)
  const entries = entryListQuery.entries;

  // Entry mutations - cache operations handle all updates internally
  const {
    toggleRead: handleToggleRead,
    toggleStar,
    markAllRead,
    isMarkAllReadPending,
  } = useEntryMutations();

  // Navigation callbacks - delegate to useEntryListQuery which owns the list state
  const goToNextEntry = useCallback(() => {
    const nextId = entryListQuery.getNextEntryId();
    if (nextId) {
      setOpenEntryId(nextId);
    }
  }, [entryListQuery, setOpenEntryId]);

  const goToPreviousEntry = useCallback(() => {
    const prevId = entryListQuery.getPreviousEntryId();
    if (prevId) {
      setOpenEntryId(prevId);
    }
  }, [entryListQuery, setOpenEntryId]);

  // Keyboard shortcuts
  const { selectedEntryId, setSelectedEntryId } = useKeyboardShortcuts({
    entries,
    onOpenEntry: setOpenEntryId,
    onClose: closeEntry,
    isEntryOpen: !!openEntryId,
    openEntryId,
    enabled: keyboardShortcutsEnabled,
    onToggleRead: handleToggleRead,
    onToggleStar: toggleStar,
    onRefresh: () => {
      utils.entries.list.invalidate();
    },
    onToggleUnreadOnly: toggleShowUnreadOnly,
    onNavigateNext: goToNextEntry,
    onNavigatePrevious: goToPreviousEntry,
  });

  // Entry click handler
  const handleEntryClick = useCallback(
    (entryId: string) => {
      setSelectedEntryId(entryId);
      setOpenEntryId(entryId);
    },
    [setSelectedEntryId, setOpenEntryId]
  );

  // Back handler
  const handleBack = useCallback(() => {
    closeEntry();
  }, [closeEntry]);

  // Mark all read handler
  const handleMarkAllRead = useCallback(
    (markAllOptions?: MarkAllReadOptions) => {
      markAllRead(markAllOptions);
    },
    [markAllRead]
  );

  // External query state for EntryList
  const externalQueryState: ExternalQueryState = useMemo(
    () => ({
      isLoading: entryListQuery.isLoading,
      isError: entryListQuery.isError,
      errorMessage: entryListQuery.errorMessage,
      isFetchingNextPage: entryListQuery.isFetchingNextPage,
      hasNextPage: entryListQuery.hasNextPage,
      fetchNextPage: entryListQuery.fetchNextPage,
      refetch: entryListQuery.refetch,
    }),
    [entryListQuery]
  );

  // Props for EntryList component
  const entryListProps = useMemo(
    () => ({
      filters: combinedFilters,
      onEntryClick: handleEntryClick,
      selectedEntryId,
      onToggleRead: handleToggleRead,
      onToggleStar: toggleStar,
      externalEntries: entries,
      externalQueryState,
      rootMargin: scrollConfig.rootMargin,
    }),
    [
      combinedFilters,
      handleEntryClick,
      selectedEntryId,
      handleToggleRead,
      toggleStar,
      entries,
      externalQueryState,
      scrollConfig.rootMargin,
    ]
  );

  // Props for EntryContent component (null if no entry open)
  const entryContentProps = useMemo(
    () =>
      openEntryId
        ? {
            entryId: openEntryId,
            onBack: handleBack,
            onSwipeNext: goToNextEntry,
            onSwipePrevious: goToPreviousEntry,
            nextEntryId: entryListQuery.nextEntryId,
            previousEntryId: entryListQuery.previousEntryId,
          }
        : null,
    [
      openEntryId,
      handleBack,
      goToNextEntry,
      goToPreviousEntry,
      entryListQuery.nextEntryId,
      entryListQuery.previousEntryId,
    ]
  );

  return {
    // Entry state
    openEntryId,
    selectedEntryId,

    // View preferences
    showUnreadOnly,
    sortOrder,
    toggleShowUnreadOnly,
    toggleSortOrder,

    // Entries
    entries,

    // Query state
    isLoading: entryListQuery.isLoading,
    subscriptionsLoading: subscriptionsQuery.isLoading,
    subscriptions: subscriptionsQuery.data,

    // Callbacks
    handleEntryClick,
    handleToggleRead,
    handleToggleStar: toggleStar,
    handleBack,
    goToNextEntry,
    goToPreviousEntry,
    nextEntryId: entryListQuery.nextEntryId,
    previousEntryId: entryListQuery.previousEntryId,
    handleMarkAllRead,
    isMarkAllReadPending,

    // Props objects
    entryListProps,
    entryContentProps,

    // Utils
    utils,
  };
}
