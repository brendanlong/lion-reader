/**
 * Saved Articles Client Component
 *
 * Client-side component for the Saved Articles page.
 * Uses the same unified components as other entry pages.
 */

"use client";

import { Suspense, useCallback, useMemo } from "react";
import {
  EntryList,
  EntryContent,
  UnreadToggle,
  SortToggle,
  type ExternalQueryState,
} from "@/components/entries";
import { useKeyboardShortcutsContext } from "@/components/keyboard";
import {
  useKeyboardShortcuts,
  useUrlViewPreferences,
  useEntryMutations,
  useEntryUrlState,
  useEntryListQuery,
  useMergedEntries,
} from "@/lib/hooks";
import { trpc } from "@/lib/trpc/client";

function SavedArticlesContent() {
  const { openEntryId, setOpenEntryId, closeEntry } = useEntryUrlState();

  const { enabled: keyboardShortcutsEnabled } = useKeyboardShortcutsContext();
  const { showUnreadOnly, toggleShowUnreadOnly, sortOrder, toggleSortOrder } =
    useUrlViewPreferences("saved");
  const utils = trpc.useUtils();

  // Use unified entry list query with type="saved"
  const entryListQuery = useEntryListQuery({
    filters: { type: "saved", unreadOnly: showUnreadOnly, sortOrder },
    openEntryId,
  });

  // Merge entries with Zustand deltas for consistent state across components
  const mergedEntries = useMergedEntries(entryListQuery.entries, {
    unreadOnly: showUnreadOnly,
  });

  // Fetch subscriptions for tag lookup
  const subscriptionsQuery = trpc.subscriptions.list.useQuery();

  // Use unified entry mutations
  const { toggleRead, toggleStar } = useEntryMutations({
    listFilters: { type: "saved", unreadOnly: showUnreadOnly, sortOrder },
  });

  // Wrapper to look up tags and pass entryType + subscriptionId + tagIds to mutations
  // Saved articles always have type "saved"
  const handleToggleRead = useCallback(
    (
      entryId: string,
      currentlyRead: boolean,
      _entryType: "web" | "email" | "saved",
      subscriptionId: string | null
    ) => {
      // Saved articles always use "saved" type regardless of what's passed
      if (!subscriptionId) {
        toggleRead(entryId, currentlyRead, "saved");
        return;
      }
      // Look up tags for this subscription
      const subscription = subscriptionsQuery.data?.items.find((sub) => sub.id === subscriptionId);
      const tagIds = subscription?.tags.map((tag) => tag.id);
      toggleRead(entryId, currentlyRead, "saved", subscriptionId, tagIds);
    },
    [toggleRead, subscriptionsQuery.data]
  );

  // Use unified keyboard shortcuts
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
        utils.entries.list.invalidate({ type: "saved" });
        utils.entries.count.invalidate({ type: "saved" });
      },
      onToggleUnreadOnly: toggleShowUnreadOnly,
    });

  const handleEntryClick = useCallback(
    (entryId: string) => {
      setSelectedEntryId(entryId);
      setOpenEntryId(entryId);
    },
    [setSelectedEntryId, setOpenEntryId]
  );

  const handleBack = useCallback(() => {
    closeEntry();
  }, [closeEntry]);

  // Build external query state for EntryList
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

  // Render both list and content, hiding the list when viewing an entry.
  // This preserves scroll position and enables seamless j/k navigation.
  return (
    <>
      {/* Entry content - only rendered when an entry is open */}
      {openEntryId && (
        <EntryContent
          key={openEntryId}
          entryId={openEntryId}
          listFilters={{ type: "saved", unreadOnly: showUnreadOnly, sortOrder }}
          onBack={handleBack}
          onSwipeNext={goToNextEntry}
          onSwipePrevious={goToPreviousEntry}
          nextEntryId={entryListQuery.nextEntryId}
          previousEntryId={entryListQuery.previousEntryId}
        />
      )}

      {/* Entry list - always mounted but hidden when viewing an entry */}
      <div className={`mx-auto max-w-3xl px-4 py-4 sm:p-6 ${openEntryId ? "hidden" : ""}`}>
        <div className="mb-4 flex items-center justify-between sm:mb-6">
          <h1 className="text-xl font-bold text-zinc-900 sm:text-2xl dark:text-zinc-50">Saved</h1>
          <div className="flex gap-2">
            <SortToggle sortOrder={sortOrder} onToggle={toggleSortOrder} />
            <UnreadToggle showUnreadOnly={showUnreadOnly} onToggle={toggleShowUnreadOnly} />
          </div>
        </div>

        <EntryList
          filters={{ type: "saved", unreadOnly: showUnreadOnly, sortOrder }}
          onEntryClick={handleEntryClick}
          selectedEntryId={selectedEntryId}
          onToggleRead={handleToggleRead}
          onToggleStar={toggleStar}
          externalEntries={mergedEntries}
          externalQueryState={externalQueryState}
          emptyMessage={
            showUnreadOnly
              ? "No unread saved articles. Toggle to show all items."
              : "No saved articles yet. Save articles to read them later."
          }
        />
      </div>
    </>
  );
}

export default function SavedArticlesPage() {
  return (
    <Suspense>
      <SavedArticlesContent />
    </Suspense>
  );
}
