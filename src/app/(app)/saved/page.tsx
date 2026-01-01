/**
 * Saved Articles Page
 *
 * Displays saved articles (read-it-later) for the user.
 */

"use client";

import { Suspense, useState, useCallback } from "react";
import {
  SavedArticleList,
  SavedArticleContent,
  type SavedArticleListEntryData,
} from "@/components/saved";
import { UnreadToggle, SortToggle } from "@/components/entries";
import { useKeyboardShortcutsContext } from "@/components/keyboard";
import {
  useSavedArticleKeyboardShortcuts,
  useSavedArticleMutations,
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
  const { showUnreadOnly, toggleShowUnreadOnly, sortOrder, toggleSortOrder } =
    useViewPreferences("saved");
  const utils = trpc.useUtils();

  // Use the consolidated mutations hook with list filters
  const { toggleRead, toggleStar } = useSavedArticleMutations({
    listFilters: { unreadOnly: showUnreadOnly, sortOrder },
  });

  // Keyboard navigation and actions (also provides swipe navigation functions)
  const { selectedArticleId, setSelectedArticleId, goToNextArticle, goToPreviousArticle } =
    useSavedArticleKeyboardShortcuts({
      articles,
      onOpenArticle: setOpenArticleId,
      onClose: closeArticle,
      isArticleOpen: !!openArticleId,
      enabled: keyboardShortcutsEnabled,
      onToggleRead: toggleRead,
      onToggleStar: toggleStar,
      onRefresh: () => {
        // Invalidate entries queries with saved type filter
        utils.entries.list.invalidate({ type: "saved" });
        utils.entries.count.invalidate({ type: "saved" });
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
  // Key forces remount when articleId changes, ensuring fresh refs and mutation state
  if (openArticleId) {
    return (
      <SavedArticleContent
        key={openArticleId}
        articleId={openArticleId}
        onBack={handleBack}
        onSwipeNext={goToNextArticle}
        onSwipePrevious={goToPreviousArticle}
      />
    );
  }

  // Otherwise, show the saved articles list
  return (
    <div className="mx-auto max-w-3xl px-4 py-4 sm:p-6">
      <div className="mb-4 flex items-center justify-between sm:mb-6">
        <h1 className="text-xl font-bold text-zinc-900 sm:text-2xl dark:text-zinc-50">Saved</h1>
        <div className="flex gap-2">
          <SortToggle sortOrder={sortOrder} onToggle={toggleSortOrder} />
          <UnreadToggle showUnreadOnly={showUnreadOnly} onToggle={toggleShowUnreadOnly} />
        </div>
      </div>

      <SavedArticleList
        filters={{ unreadOnly: showUnreadOnly, sortOrder }}
        onArticleClick={handleArticleClick}
        selectedArticleId={selectedArticleId}
        onArticlesLoaded={handleArticlesLoaded}
        onToggleRead={toggleRead}
        onToggleStar={toggleStar}
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
