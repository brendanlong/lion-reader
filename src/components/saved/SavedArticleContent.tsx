/**
 * SavedArticleContent Component
 *
 * Displays the full content of a single saved article.
 * Fetches article data and delegates rendering to the shared ArticleContentBody.
 */

"use client";

import { useEffect, useRef, useState } from "react";
import { trpc } from "@/lib/trpc/client";
import { useSavedArticleMutations } from "@/lib/hooks";
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
  const hasMarkedRead = useRef(false);
  const [showOriginal, setShowOriginal] = useState(false);

  // Fetch the saved article using unified entries endpoint
  const { data, isLoading, isError, error, refetch } = trpc.entries.get.useQuery({ id: articleId });

  // Use the consolidated mutations hook (no list filters since we're in single article view)
  // normy automatically propagates changes to entries.get when server responds
  const { markRead, star, unstar, isStarPending, isMarkReadPending } = useSavedArticleMutations();

  const article = data?.entry;

  // Mark article as read when component mounts and article is loaded (only once)
  useEffect(() => {
    if (article && !hasMarkedRead.current) {
      hasMarkedRead.current = true;
      // Only mark as read if it's currently unread
      if (!article.read) {
        markRead([articleId], true);
      }
    }
  }, [article, articleId, markRead]);

  // Handle star toggle
  const handleStarToggle = () => {
    if (!article) return;

    if (article.starred) {
      unstar(articleId);
    } else {
      star(articleId);
    }
  };

  // Handle read toggle
  const handleReadToggle = () => {
    if (!article) return;
    markRead([articleId], !article.read);
  };

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
      source={article.feedTitle ?? getDomain(article.url ?? "")}
      author={article.author}
      url={article.url ?? ""}
      date={article.fetchedAt}
      datePrefix="Saved"
      contentOriginal={article.contentOriginal}
      contentCleaned={article.contentCleaned}
      fallbackContent={article.summary}
      read={article.read}
      starred={article.starred}
      onBack={onBack}
      onToggleRead={handleReadToggle}
      onToggleStar={handleStarToggle}
      isStarLoading={isStarPending}
      isReadLoading={isMarkReadPending}
      showOriginal={showOriginal}
      setShowOriginal={setShowOriginal}
      narrationArticleType="saved"
    />
  );
}
