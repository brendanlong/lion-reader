/**
 * Saved Articles Page
 *
 * Displays saved articles (read-it-later) for the user.
 */

"use client";

import { useState, useCallback } from "react";
import { SavedArticleList, type SavedArticleListEntryData } from "@/components/saved";
import { SavedArticleContent } from "@/components/saved";
import { useKeyboardShortcutsContext } from "@/components/keyboard";
import { useSavedArticleKeyboardShortcuts } from "@/lib/hooks";
import { trpc } from "@/lib/trpc/client";

export default function SavedArticlesPage() {
  const [openArticleId, setOpenArticleId] = useState<string | null>(null);
  const [articles, setArticles] = useState<SavedArticleListEntryData[]>([]);

  const { enabled: keyboardShortcutsEnabled } = useKeyboardShortcutsContext();
  const utils = trpc.useUtils();

  // Mutations for keyboard actions
  const markReadMutation = trpc.saved.markRead.useMutation({
    onSuccess: () => {
      utils.saved.list.invalidate();
      utils.saved.count.invalidate();
    },
  });

  const starMutation = trpc.saved.star.useMutation({
    onSuccess: () => {
      utils.saved.list.invalidate();
    },
  });

  const unstarMutation = trpc.saved.unstar.useMutation({
    onSuccess: () => {
      utils.saved.list.invalidate();
    },
  });

  // Keyboard navigation and actions
  const { selectedArticleId, setSelectedArticleId } = useSavedArticleKeyboardShortcuts({
    articles,
    onOpenArticle: (articleId) => setOpenArticleId(articleId),
    onClose: () => setOpenArticleId(null),
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
  });

  const handleArticleClick = useCallback(
    (articleId: string) => {
      setSelectedArticleId(articleId);
      setOpenArticleId(articleId);
    },
    [setSelectedArticleId]
  );

  const handleBack = useCallback(() => {
    setOpenArticleId(null);
  }, []);

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
      </div>

      <SavedArticleList
        onArticleClick={handleArticleClick}
        selectedArticleId={selectedArticleId}
        onArticlesLoaded={handleArticlesLoaded}
        emptyMessage="No saved articles yet. Save articles to read them later."
      />
    </div>
  );
}
