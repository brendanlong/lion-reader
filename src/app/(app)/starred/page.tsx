/**
 * Starred Entries Page
 *
 * Displays entries that the user has starred for later reading.
 */

"use client";

import { useState, useCallback } from "react";
import { toast } from "sonner";
import {
  EntryList,
  EntryContent,
  UnreadToggle,
  SortToggle,
  type EntryListEntryData,
} from "@/components/entries";
import { useKeyboardShortcutsContext } from "@/components/keyboard";
import { useKeyboardShortcuts, useViewPreferences, type KeyboardEntryData } from "@/lib/hooks";
import { trpc } from "@/lib/trpc/client";

export default function StarredEntriesPage() {
  const [openEntryId, setOpenEntryId] = useState<string | null>(null);
  const [entries, setEntries] = useState<KeyboardEntryData[]>([]);

  const { enabled: keyboardShortcutsEnabled } = useKeyboardShortcutsContext();
  const { showUnreadOnly, toggleShowUnreadOnly, sortOrder, toggleSortOrder } =
    useViewPreferences("starred");
  const utils = trpc.useUtils();

  // Mutations for keyboard actions with optimistic updates
  const markReadMutation = trpc.entries.markRead.useMutation({
    onMutate: async (variables) => {
      // Cancel any in-flight queries
      await utils.entries.list.cancel();

      // Snapshot current state
      const previousData = utils.entries.list.getInfiniteData({
        starredOnly: true,
        unreadOnly: showUnreadOnly,
        sortOrder,
      });

      // Optimistically update entries
      utils.entries.list.setInfiniteData(
        { starredOnly: true, unreadOnly: showUnreadOnly, sortOrder },
        (oldData) => {
          if (!oldData) return oldData;
          return {
            ...oldData,
            pages: oldData.pages.map((page) => ({
              ...page,
              items: page.items.map((item) =>
                variables.ids.includes(item.id) ? { ...item, read: variables.read } : item
              ),
            })),
          };
        }
      );

      // Also update individual entry queries for UI in content view
      for (const id of variables.ids) {
        utils.entries.get.setData({ id }, (oldData) => {
          if (!oldData) return oldData;
          return {
            ...oldData,
            entry: { ...oldData.entry, read: variables.read },
          };
        });
      }

      return { previousData };
    },
    onError: (_error, variables, context) => {
      // Rollback to previous state
      if (context?.previousData) {
        utils.entries.list.setInfiniteData(
          { starredOnly: true, unreadOnly: showUnreadOnly, sortOrder },
          context.previousData
        );
      }
      // Invalidate individual entry queries to restore correct state
      for (const id of variables.ids) {
        utils.entries.get.invalidate({ id });
      }
      toast.error("Failed to update read status");
    },
    onSettled: () => {
      // Invalidate subscription counts as they need server data
      utils.subscriptions.list.invalidate();
    },
  });

  const starMutation = trpc.entries.star.useMutation({
    onMutate: async (variables) => {
      await utils.entries.list.cancel();

      const previousData = utils.entries.list.getInfiniteData({
        starredOnly: true,
        unreadOnly: showUnreadOnly,
        sortOrder,
      });

      utils.entries.list.setInfiniteData(
        { starredOnly: true, unreadOnly: showUnreadOnly, sortOrder },
        (oldData) => {
          if (!oldData) return oldData;
          return {
            ...oldData,
            pages: oldData.pages.map((page) => ({
              ...page,
              items: page.items.map((item) =>
                item.id === variables.id ? { ...item, starred: true } : item
              ),
            })),
          };
        }
      );

      // Also update individual entry query
      utils.entries.get.setData({ id: variables.id }, (oldData) => {
        if (!oldData) return oldData;
        return {
          ...oldData,
          entry: { ...oldData.entry, starred: true },
        };
      });

      return { previousData };
    },
    onError: (_error, variables, context) => {
      if (context?.previousData) {
        utils.entries.list.setInfiniteData(
          { starredOnly: true, unreadOnly: showUnreadOnly, sortOrder },
          context.previousData
        );
      }
      utils.entries.get.invalidate({ id: variables.id });
      toast.error("Failed to star entry");
    },
  });

  const unstarMutation = trpc.entries.unstar.useMutation({
    onMutate: async (variables) => {
      await utils.entries.list.cancel();

      const previousData = utils.entries.list.getInfiniteData({
        starredOnly: true,
        unreadOnly: showUnreadOnly,
        sortOrder,
      });

      utils.entries.list.setInfiniteData(
        { starredOnly: true, unreadOnly: showUnreadOnly, sortOrder },
        (oldData) => {
          if (!oldData) return oldData;
          return {
            ...oldData,
            pages: oldData.pages.map((page) => ({
              ...page,
              items: page.items.map((item) =>
                item.id === variables.id ? { ...item, starred: false } : item
              ),
            })),
          };
        }
      );

      // Also update individual entry query
      utils.entries.get.setData({ id: variables.id }, (oldData) => {
        if (!oldData) return oldData;
        return {
          ...oldData,
          entry: { ...oldData.entry, starred: false },
        };
      });

      return { previousData };
    },
    onError: (_error, variables, context) => {
      if (context?.previousData) {
        utils.entries.list.setInfiniteData(
          { starredOnly: true, unreadOnly: showUnreadOnly, sortOrder },
          context.previousData
        );
      }
      utils.entries.get.invalidate({ id: variables.id });
      toast.error("Failed to unstar entry");
    },
  });

  // Keyboard navigation and actions
  const { selectedEntryId, setSelectedEntryId } = useKeyboardShortcuts({
    entries,
    onOpenEntry: (entryId) => setOpenEntryId(entryId),
    onClose: () => setOpenEntryId(null),
    isEntryOpen: !!openEntryId,
    enabled: keyboardShortcutsEnabled,
    onToggleRead: (entryId, currentlyRead) => {
      markReadMutation.mutate({ ids: [entryId], read: !currentlyRead });
    },
    onToggleStar: (entryId, currentlyStarred) => {
      if (currentlyStarred) {
        unstarMutation.mutate({ id: entryId });
      } else {
        starMutation.mutate({ id: entryId });
      }
    },
    onRefresh: () => {
      utils.entries.list.invalidate();
    },
    onToggleUnreadOnly: toggleShowUnreadOnly,
  });

  const handleEntryClick = useCallback(
    (entryId: string) => {
      setSelectedEntryId(entryId);
      setOpenEntryId(entryId);
    },
    [setSelectedEntryId]
  );

  const handleBack = useCallback(() => {
    setOpenEntryId(null);
  }, []);

  const handleEntriesLoaded = useCallback((loadedEntries: EntryListEntryData[]) => {
    setEntries(loadedEntries);
  }, []);

  // Handler to toggle read status
  const handleToggleRead = useCallback(
    (entryId: string, currentlyRead: boolean) => {
      markReadMutation.mutate({ ids: [entryId], read: !currentlyRead });
    },
    [markReadMutation]
  );

  // If an entry is open, show the full content view
  if (openEntryId) {
    return (
      <EntryContent entryId={openEntryId} onBack={handleBack} onToggleRead={handleToggleRead} />
    );
  }

  // Otherwise, show the starred entries list
  return (
    <div className="mx-auto max-w-3xl px-4 py-4 sm:p-6">
      <div className="mb-4 flex items-center justify-between sm:mb-6">
        <h1 className="text-xl font-bold text-zinc-900 sm:text-2xl dark:text-zinc-50">Starred</h1>
        <div className="flex gap-2">
          <SortToggle sortOrder={sortOrder} onToggle={toggleSortOrder} />
          <UnreadToggle showUnreadOnly={showUnreadOnly} onToggle={toggleShowUnreadOnly} />
        </div>
      </div>

      <EntryList
        filters={{ starredOnly: true, unreadOnly: showUnreadOnly, sortOrder }}
        onEntryClick={handleEntryClick}
        selectedEntryId={selectedEntryId}
        onEntriesLoaded={handleEntriesLoaded}
        emptyMessage={
          showUnreadOnly
            ? "No unread starred entries. Toggle to show all starred items."
            : "No starred entries yet. Star entries to save them for later."
        }
      />
    </div>
  );
}
