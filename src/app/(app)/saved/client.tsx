/**
 * Saved Articles Client Component
 *
 * Client-side component for the Saved Articles page.
 * Contains all the interactive logic for displaying and managing saved articles.
 */

"use client";

import { Suspense, useState, useCallback, useMemo } from "react";
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
  useUrlViewPreferences,
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
    useUrlViewPreferences("saved");
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

  // Calculate next and previous article IDs for prefetching
  const { nextArticleId, previousArticleId } = useMemo(() => {
    if (!openArticleId) return { nextArticleId: undefined, previousArticleId: undefined };

    const currentIndex = articles.findIndex((a) => a.id === openArticleId);
    if (currentIndex === -1) return { nextArticleId: undefined, previousArticleId: undefined };

    return {
      nextArticleId: currentIndex < articles.length - 1 ? articles[currentIndex + 1].id : undefined,
      previousArticleId: currentIndex > 0 ? articles[currentIndex - 1].id : undefined,
    };
  }, [openArticleId, articles]);

  // Render both list and content, hiding the list when viewing an article.
  // This preserves scroll position and enables seamless j/k navigation.
  return (
    <>
      {/* Article content - only rendered when an article is open */}
      {openArticleId && (
        <SavedArticleContent
          key={openArticleId}
          articleId={openArticleId}
          onBack={handleBack}
          onSwipeNext={goToNextArticle}
          onSwipePrevious={goToPreviousArticle}
          nextArticleId={nextArticleId}
          previousArticleId={previousArticleId}
        />
      )}

      {/* Article list - always mounted but hidden when viewing an article */}
      <div className={`mx-auto max-w-3xl px-4 py-4 sm:p-6 ${openArticleId ? "hidden" : ""}`}>
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
    </>
  );
}

export function SavedArticlesClient() {
  return (
    <Suspense>
      <SavedArticlesContent />
    </Suspense>
  );
}
