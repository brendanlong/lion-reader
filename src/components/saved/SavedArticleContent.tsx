/**
 * SavedArticleContent Component
 *
 * Displays the full content of a single saved article.
 * Fetches article data and delegates rendering to the shared ArticleContentBody.
 */

"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc/client";
import {
  ArticleContentBody,
  ArticleContentSkeleton,
  ArticleContentError,
  getDomain,
} from "@/components/articles/ArticleContentBody";

/**
 * Props for the SavedArticleContent component.
 */
interface SavedArticleContentProps {
  /**
   * The ID of the saved article to display.
   */
  articleId: string;

  /**
   * Optional callback when the back button is clicked.
   */
  onBack?: () => void;
}

/**
 * SavedArticleContent component.
 *
 * Fetches and displays the full content of a saved article.
 * Marks the article as read on mount.
 */
export function SavedArticleContent({ articleId, onBack }: SavedArticleContentProps) {
  const utils = trpc.useUtils();
  const queryClient = useQueryClient();
  const hasMarkedRead = useRef(false);
  const [showOriginal, setShowOriginal] = useState(false);

  // Fetch the saved article
  const { data, isLoading, isError, error, refetch } = trpc.saved.get.useQuery({ id: articleId });

  // Helper to update article in all cached infinite queries
  const updateArticleInAllLists = useCallback(
    (
      id: string,
      updater: (article: { id: string; read: boolean; starred: boolean }) => {
        id: string;
        read: boolean;
        starred: boolean;
      }
    ) => {
      // Get all cached infinite query data for saved.list
      // tRPC query keys have the format [["saved", "list"], { input, type }]
      const queries = queryClient.getQueriesData<{
        pages: Array<{
          items: Array<{ id: string; read: boolean; starred: boolean }>;
          nextCursor?: string;
        }>;
        pageParams: unknown[];
      }>({
        queryKey: [["saved", "list"]],
      });

      // Update each cached query
      for (const [queryKey, data] of queries) {
        if (!data) continue;

        const updatedData = {
          ...data,
          pages: data.pages.map((page) => ({
            ...page,
            items: page.items.map((item) => (item.id === id ? updater(item) : item)),
          })),
        };

        queryClient.setQueryData(queryKey, updatedData);
      }
    },
    [queryClient]
  );

  // Mark read mutation with optimistic updates
  const markReadMutation = trpc.saved.markRead.useMutation({
    onMutate: async (variables) => {
      // Cancel in-flight queries
      await utils.saved.get.cancel({ id: articleId });
      await utils.saved.list.cancel();

      // Snapshot current state
      const previousData = utils.saved.get.getData({ id: articleId });

      // Optimistically update individual article query
      utils.saved.get.setData({ id: articleId }, (oldData) => {
        if (!oldData) return oldData;
        return {
          ...oldData,
          article: { ...oldData.article, read: variables.read },
        };
      });

      // Also update article in all cached list queries
      updateArticleInAllLists(articleId, (article) => ({ ...article, read: variables.read }));

      return { previousData };
    },
    onError: (_error, _variables, context) => {
      // Rollback to previous state
      if (context?.previousData) {
        utils.saved.get.setData({ id: articleId }, context.previousData);
      }
      // Re-fetch lists to restore correct state
      utils.saved.list.invalidate();
      toast.error("Failed to update read status");
    },
    onSettled: () => {
      // Invalidate count as it needs server data (computed server-side)
      utils.saved.count.invalidate();
    },
  });

  // Star/unstar mutations with optimistic updates
  const starMutation = trpc.saved.star.useMutation({
    onMutate: async () => {
      await utils.saved.get.cancel({ id: articleId });
      await utils.saved.list.cancel();

      const previousData = utils.saved.get.getData({ id: articleId });

      utils.saved.get.setData({ id: articleId }, (oldData) => {
        if (!oldData) return oldData;
        return {
          ...oldData,
          article: { ...oldData.article, starred: true },
        };
      });

      // Also update article in all cached list queries
      updateArticleInAllLists(articleId, (article) => ({ ...article, starred: true }));

      return { previousData };
    },
    onError: (_error, _variables, context) => {
      if (context?.previousData) {
        utils.saved.get.setData({ id: articleId }, context.previousData);
      }
      // Re-fetch lists to restore correct state
      utils.saved.list.invalidate();
      toast.error("Failed to star article");
    },
  });

  const unstarMutation = trpc.saved.unstar.useMutation({
    onMutate: async () => {
      await utils.saved.get.cancel({ id: articleId });
      await utils.saved.list.cancel();

      const previousData = utils.saved.get.getData({ id: articleId });

      utils.saved.get.setData({ id: articleId }, (oldData) => {
        if (!oldData) return oldData;
        return {
          ...oldData,
          article: { ...oldData.article, starred: false },
        };
      });

      // Also update article in all cached list queries
      updateArticleInAllLists(articleId, (article) => ({ ...article, starred: false }));

      return { previousData };
    },
    onError: (_error, _variables, context) => {
      if (context?.previousData) {
        utils.saved.get.setData({ id: articleId }, context.previousData);
      }
      // Re-fetch lists to restore correct state
      utils.saved.list.invalidate();
      toast.error("Failed to unstar article");
    },
  });

  const article = data?.article;

  // Mark article as read when component mounts and article is loaded
  useEffect(() => {
    if (article && !article.read && !hasMarkedRead.current) {
      hasMarkedRead.current = true;
      markReadMutation.mutate({ ids: [articleId], read: true });
    }
  }, [article, articleId, markReadMutation]);

  // Handle star toggle
  const handleStarToggle = () => {
    if (!article) return;

    if (article.starred) {
      unstarMutation.mutate({ id: articleId });
    } else {
      starMutation.mutate({ id: articleId });
    }
  };

  // Handle read toggle
  const handleReadToggle = () => {
    if (!article) return;
    markReadMutation.mutate({ ids: [articleId], read: !article.read });
  };

  const isStarLoading = starMutation.isPending || unstarMutation.isPending;
  const isReadLoading = markReadMutation.isPending;

  // Loading state
  if (isLoading) {
    return <ArticleContentSkeleton />;
  }

  // Error state
  if (isError) {
    return (
      <ArticleContentError
        message={error?.message ?? "Failed to load article"}
        onRetry={() => refetch()}
      />
    );
  }

  // Article not found
  if (!article) {
    return <ArticleContentError message="Article not found" onRetry={() => refetch()} />;
  }

  // Render the article content using shared component
  return (
    <ArticleContentBody
      articleId={articleId}
      title={article.title ?? "Untitled"}
      source={article.siteName ?? getDomain(article.url)}
      author={article.author}
      url={article.url}
      date={article.savedAt}
      datePrefix="Saved"
      contentOriginal={article.contentOriginal}
      contentCleaned={article.contentCleaned}
      fallbackContent={article.excerpt}
      read={article.read}
      starred={article.starred}
      onBack={onBack}
      onToggleRead={handleReadToggle}
      onToggleStar={handleStarToggle}
      isStarLoading={isStarLoading}
      isReadLoading={isReadLoading}
      showOriginal={showOriginal}
      setShowOriginal={setShowOriginal}
      narrationArticleType="saved"
    />
  );
}
