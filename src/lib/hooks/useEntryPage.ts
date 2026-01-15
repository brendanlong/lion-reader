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
import { type EntryType } from "@/lib/store/realtime";
import { useEntryUrlState } from "./useEntryUrlState";
import { useUrlViewPreferences } from "./useUrlViewPreferences";
import { type ViewType } from "./viewPreferences";
import { useEntryListQuery, type EntryListData } from "./useEntryListQuery";
import { useMergedEntries } from "./useEntryDeltas";
import { useEntryMutations, type MarkAllReadOptions } from "./useEntryMutations";
import { useKeyboardShortcuts } from "./useKeyboardShortcuts";

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

  // Merged entries for display
  entries: EntryListData[];

  // Query state
  isLoading: boolean;
  subscriptionsLoading: boolean;
  subscriptions: { items: SubscriptionItem[] } | undefined;

  // Callbacks for EntryList
  handleEntryClick: (entryId: string) => void;
  handleToggleRead: (
    entryId: string,
    currentlyRead: boolean,
    entryType: EntryType,
    subscriptionId: string | null
  ) => void;
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
    onToggleRead: (
      entryId: string,
      currentlyRead: boolean,
      entryType: EntryType,
      subscriptionId: string | null
    ) => void;
    onToggleStar: (entryId: string, currentlyStarred: boolean) => void;
    externalEntries: EntryListData[];
    externalQueryState: ExternalQueryState;
  };

  entryContentProps: {
    entryId: string;
    listFilters: EntryPageFilters & { unreadOnly: boolean; sortOrder: "newest" | "oldest" };
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
  const { viewId, viewScopeId, filters = {} } = options;

  const utils = trpc.useUtils();

  // URL state for open entry
  const { openEntryId, setOpenEntryId, closeEntry } = useEntryUrlState();

  // Keyboard shortcuts context
  const { enabled: keyboardShortcutsEnabled } = useKeyboardShortcutsContext();

  // View preferences (unread only, sort order)
  const { showUnreadOnly, toggleShowUnreadOnly, sortOrder, toggleSortOrder } =
    useUrlViewPreferences(viewId, viewScopeId);

  // Combined filters including view preferences
  const combinedFilters = useMemo(
    () => ({
      ...filters,
      unreadOnly: showUnreadOnly,
      sortOrder,
    }),
    [filters, showUnreadOnly, sortOrder]
  );

  // Entry list query
  const entryListQuery = useEntryListQuery({
    filters: combinedFilters,
    openEntryId,
  });

  // Merge entries with Zustand deltas
  const mergedEntries = useMergedEntries(entryListQuery.entries, {
    unreadOnly: showUnreadOnly,
    starredOnly: filters.starredOnly,
  });

  // Subscriptions query for tag lookup
  const subscriptionsQuery = trpc.subscriptions.list.useQuery();

  // Entry mutations
  const { toggleRead, toggleStar, markAllRead, isMarkAllReadPending } = useEntryMutations({
    listFilters: combinedFilters,
  });

  // Wrapper to look up tags and pass to mutations
  const handleToggleRead = useCallback(
    (
      entryId: string,
      currentlyRead: boolean,
      entryType: EntryType,
      subscriptionId: string | null
    ) => {
      if (!subscriptionId) {
        toggleRead(entryId, currentlyRead, entryType);
        return;
      }
      const subscription = subscriptionsQuery.data?.items.find((sub) => sub.id === subscriptionId);
      const tagIds = subscription?.tags.map((tag) => tag.id);
      toggleRead(entryId, currentlyRead, entryType, subscriptionId, tagIds);
    },
    [toggleRead, subscriptionsQuery.data]
  );

  // Keyboard shortcuts
  const { selectedEntryId, setSelectedEntryId, goToNextEntry, goToPreviousEntry } =
    useKeyboardShortcuts({
      entries: mergedEntries,
      onOpenEntry: setOpenEntryId,
      onClose: closeEntry,
      isEntryOpen: !!openEntryId,
      enabled: keyboardShortcutsEnabled,
      onToggleRead: handleToggleRead,
      onToggleStar: toggleStar,
      onRefresh: () => {
        utils.entries.list.invalidate();
      },
      onToggleUnreadOnly: toggleShowUnreadOnly,
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
      externalEntries: mergedEntries,
      externalQueryState,
    }),
    [
      combinedFilters,
      handleEntryClick,
      selectedEntryId,
      handleToggleRead,
      toggleStar,
      mergedEntries,
      externalQueryState,
    ]
  );

  // Props for EntryContent component (null if no entry open)
  const entryContentProps = useMemo(
    () =>
      openEntryId
        ? {
            entryId: openEntryId,
            listFilters: combinedFilters,
            onBack: handleBack,
            onSwipeNext: goToNextEntry,
            onSwipePrevious: goToPreviousEntry,
            nextEntryId: entryListQuery.nextEntryId,
            previousEntryId: entryListQuery.previousEntryId,
          }
        : null,
    [
      openEntryId,
      combinedFilters,
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

    // Merged entries
    entries: mergedEntries,

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
