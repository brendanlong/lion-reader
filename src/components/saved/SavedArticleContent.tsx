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

  /**
   * Optional callback when swiping to next article.
   */
  onSwipeNext?: () => void;

  /**
   * Optional callback when swiping to previous article.
   */
  onSwipePrevious?: () => void;

  /**
   * Optional ID of the next article to prefetch.
   */
  nextArticleId?: string;

  /**
   * Optional ID of the previous article to prefetch.
   */
  previousArticleId?: string;
}

/**
 * SavedArticleContent component.
 *
 * Fetches and displays the full content of a saved article.
 * Marks the article as read on mount.
 */
export function SavedArticleContent({
  articleId,
  onBack,
  onSwipeNext,
  onSwipePrevious,
  nextArticleId,
  previousArticleId,
}: SavedArticleContentProps) {
  const lastMarkedReadId = useRef<string | null>(null);
  const [showOriginal, setShowOriginal] = useState(false);

  // Fetch the saved article using unified entries endpoint
  const { data, isLoading, isError, error, refetch } = trpc.entries.get.useQuery({ id: articleId });

  // Prefetch next and previous articles with active observers to keep them in cache
  // These queries run in parallel and don't block the main article fetch
  // We don't use their loading states, so they're invisible to the UI
  trpc.entries.get.useQuery({ id: nextArticleId! }, { enabled: !!nextArticleId });
  trpc.entries.get.useQuery({ id: previousArticleId! }, { enabled: !!previousArticleId });

  // Use the consolidated mutations hook (no list filters since we're in single article view)
  // normy automatically propagates changes to entries.get when server responds
  const { markRead, star, unstar } = useSavedArticleMutations();

  const article = data?.entry;

  // Mark article as read when component mounts and article is loaded
  // Uses lastMarkedReadId to track which article was marked, correctly handling navigation between articles
  useEffect(() => {
    if (article && lastMarkedReadId.current !== articleId && !article.read) {
      lastMarkedReadId.current = articleId;
      markRead([articleId], true);
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

  // Determine content based on loading/error/success state
  let content: React.ReactNode;
  if (isLoading) {
    content = <ArticleContentSkeleton />;
  } else if (isError) {
    content = (
      <ArticleContentError
        message={error?.message ?? "Failed to load article"}
        onRetry={() => refetch()}
      />
    );
  } else if (!article) {
    content = <ArticleContentError message="Article not found" onRetry={() => refetch()} />;
  } else {
    content = (
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
        showOriginal={showOriginal}
        setShowOriginal={setShowOriginal}
        onSwipeNext={onSwipeNext}
        onSwipePrevious={onSwipePrevious}
      />
    );
  }

  // Wrap in scroll container - each article gets its own container that starts at scroll 0
  return <div className="h-full overflow-y-auto">{content}</div>;
}
