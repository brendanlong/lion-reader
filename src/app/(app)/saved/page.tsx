/**
 * Saved Articles Page
 *
 * Displays saved articles (read-it-later) for the user.
 */

"use client";

import { Suspense, useState, useCallback } from "react";
import { toast } from "sonner";
import {
  SavedArticleList,
  SavedArticleContent,
  type SavedArticleListEntryData,
} from "@/components/saved";
import { UnreadToggle } from "@/components/entries";
import { useKeyboardShortcutsContext } from "@/components/keyboard";
import {
  useSavedArticleKeyboardShortcuts,
  useViewPreferences,
  useEntryUrlState,
} from "@/lib/hooks";
import { trpc } from "@/lib/trpc/client";

function SavedArticlesContent() {
  const {
    openEntryId: openArticleId,
    setOpenEntryId: setOpenArticleId,
    closeEntry: closeArticle,
  } = useEntryUrlState();
  const [articles, setArticles] = useState<SavedArticleListEntryData[]>([]);

  const { enabled: keyboardShortcutsEnabled } = useKeyboardShortcutsContext();
  const { showUnreadOnly, toggleShowUnreadOnly } = useViewPreferences("saved");
  const utils = trpc.useUtils();

  // Mutations for keyboard actions with optimistic updates
  const markReadMutation = trpc.saved.markRead.useMutation({
    onMutate: async (variables) => {
      // Cancel any in-flight queries
      await utils.saved.list.cancel();

      // Snapshot current state
      const previousData = utils.saved.list.getInfiniteData({
        unreadOnly: showUnreadOnly,
      });

      // Optimistically update articles
      utils.saved.list.setInfiniteData({ unreadOnly: showUnreadOnly }, (oldData) => {
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
      });

      // Also update individual article queries
      for (const id of variables.ids) {
        utils.saved.get.setData({ id }, (oldData) => {
          if (!oldData) return oldData;
          return {
            ...oldData,
            article: { ...oldData.article, read: variables.read },
          };
        });
      }

      return { previousData };
    },
    onError: (_error, variables, context) => {
      // Rollback to previous state
      if (context?.previousData) {
        utils.saved.list.setInfiniteData({ unreadOnly: showUnreadOnly }, context.previousData);
      }
      // Invalidate individual article queries to restore correct state
      for (const id of variables.ids) {
        utils.saved.get.invalidate({ id });
      }
      toast.error("Failed to update read status");
    },
    onSettled: () => {
      // Invalidate count as it needs server data
      utils.saved.count.invalidate();
    },
  });

  const starMutation = trpc.saved.star.useMutation({
    onMutate: async (variables) => {
      await utils.saved.list.cancel();

      const previousData = utils.saved.list.getInfiniteData({
        unreadOnly: showUnreadOnly,
      });

      utils.saved.list.setInfiniteData({ unreadOnly: showUnreadOnly }, (oldData) => {
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
      });

      // Also update individual article query
      utils.saved.get.setData({ id: variables.id }, (oldData) => {
        if (!oldData) return oldData;
        return {
          ...oldData,
          article: { ...oldData.article, starred: true },
        };
      });

      return { previousData };
    },
    onError: (_error, variables, context) => {
      if (context?.previousData) {
        utils.saved.list.setInfiniteData({ unreadOnly: showUnreadOnly }, context.previousData);
      }
      utils.saved.get.invalidate({ id: variables.id });
      toast.error("Failed to star article");
    },
  });

  const unstarMutation = trpc.saved.unstar.useMutation({
    onMutate: async (variables) => {
      await utils.saved.list.cancel();

      const previousData = utils.saved.list.getInfiniteData({
        unreadOnly: showUnreadOnly,
      });

      utils.saved.list.setInfiniteData({ unreadOnly: showUnreadOnly }, (oldData) => {
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
      });

      // Also update individual article query
      utils.saved.get.setData({ id: variables.id }, (oldData) => {
        if (!oldData) return oldData;
        return {
          ...oldData,
          article: { ...oldData.article, starred: false },
        };
      });

      return { previousData };
    },
    onError: (_error, variables, context) => {
      if (context?.previousData) {
        utils.saved.list.setInfiniteData({ unreadOnly: showUnreadOnly }, context.previousData);
      }
      utils.saved.get.invalidate({ id: variables.id });
      toast.error("Failed to unstar article");
    },
  });

  // Keyboard navigation and actions
  const { selectedArticleId, setSelectedArticleId } = useSavedArticleKeyboardShortcuts({
    articles,
    onOpenArticle: setOpenArticleId,
    onClose: closeArticle,
    isArticleOpen: !!openArticleId,
    enabled: keyboardShortcutsEnabled,
    onToggleRead: (articleId, currentlyRead) => {
      markReadMutation.mutate({ ids: [articleId], read: !currentlyRead });
    },
    onToggleStar: (articleId, currentlyStarred) => {
      if (currentlyStarred) {
        unstarMutation.mutate({ id: articleId });
      } else {
        starMutation.mutate({ id: articleId });
      }
    },
    onRefresh: () => {
      utils.saved.list.invalidate();
      utils.saved.count.invalidate();
    },
    onToggleUnreadOnly: toggleShowUnreadOnly,
  });

  const handleArticleClick = useCallback(
    (articleId: string) => {
      setSelectedArticleId(articleId);
      setOpenArticleId(articleId);
    },
    [setSelectedArticleId, setOpenArticleId]
  );

  const handleBack = useCallback(() => {
    closeArticle();
  }, [closeArticle]);

  const handleArticlesLoaded = useCallback((loadedArticles: SavedArticleListEntryData[]) => {
    setArticles(loadedArticles);
  }, []);

  // If an article is open, show the full content view
  if (openArticleId) {
    return <SavedArticleContent articleId={openArticleId} onBack={handleBack} />;
  }

  // Otherwise, show the saved articles list
  return (
    <div className="mx-auto max-w-3xl px-4 py-4 sm:p-6">
      <div className="mb-4 flex items-center justify-between sm:mb-6">
        <h1 className="text-xl font-bold text-zinc-900 sm:text-2xl dark:text-zinc-50">Saved</h1>
        <UnreadToggle showUnreadOnly={showUnreadOnly} onToggle={toggleShowUnreadOnly} />
      </div>

      <SavedArticleList
        filters={{ unreadOnly: showUnreadOnly }}
        onArticleClick={handleArticleClick}
        selectedArticleId={selectedArticleId}
        onArticlesLoaded={handleArticlesLoaded}
        emptyMessage={
          showUnreadOnly
            ? "No unread saved articles. Toggle to show all items."
            : "No saved articles yet. Save articles to read them later."
        }
      />
    </div>
  );
}

export default function SavedArticlesPage() {
  return (
    <Suspense>
      <SavedArticlesContent />
    </Suspense>
  );
}
