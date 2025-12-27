/**
 * SavedArticleContent Component
 *
 * Displays the full content of a single saved article.
 * Includes title, author, date, content (safely sanitized), star button,
 * and link to original article. Marks article as read when viewed.
 */

"use client";

import { useEffect, useRef } from "react";
import DOMPurify from "dompurify";
import { trpc } from "@/lib/trpc/client";
import { Button } from "@/components/ui/button";

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
 * Loading skeleton for saved article content.
 */
function SavedArticleContentSkeleton() {
  return (
    <div className="mx-auto max-w-3xl animate-pulse px-4 py-6 sm:py-8">
      {/* Back button placeholder */}
      <div className="mb-6 h-8 w-20 rounded bg-zinc-200 dark:bg-zinc-700" />

      {/* Title placeholder */}
      <div className="mb-2 h-8 w-3/4 rounded bg-zinc-200 dark:bg-zinc-700" />
      <div className="mb-4 h-8 w-1/2 rounded bg-zinc-200 dark:bg-zinc-700" />

      {/* Meta row placeholder */}
      <div className="mb-6 flex items-center gap-4">
        <div className="h-4 w-24 rounded bg-zinc-200 dark:bg-zinc-700" />
        <div className="h-4 w-32 rounded bg-zinc-200 dark:bg-zinc-700" />
      </div>

      {/* Action buttons placeholder */}
      <div className="mb-8 flex gap-3">
        <div className="h-10 w-24 rounded bg-zinc-200 dark:bg-zinc-700" />
        <div className="h-10 w-32 rounded bg-zinc-200 dark:bg-zinc-700" />
      </div>

      {/* Content placeholders */}
      <div className="space-y-4">
        <div className="h-4 w-full rounded bg-zinc-200 dark:bg-zinc-700" />
        <div className="h-4 w-full rounded bg-zinc-200 dark:bg-zinc-700" />
        <div className="h-4 w-5/6 rounded bg-zinc-200 dark:bg-zinc-700" />
        <div className="h-4 w-full rounded bg-zinc-200 dark:bg-zinc-700" />
        <div className="h-4 w-3/4 rounded bg-zinc-200 dark:bg-zinc-700" />
      </div>
    </div>
  );
}

/**
 * Error state component for saved article content.
 */
function SavedArticleContentError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-center">
      <svg
        className="mb-4 h-16 w-16 text-red-400 dark:text-red-500"
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
        aria-hidden="true"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={1.5}
          d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
        />
      </svg>
      <p className="mb-4 text-base text-zinc-600 dark:text-zinc-400">{message}</p>
      <Button onClick={onRetry} variant="secondary">
        Try again
      </Button>
    </div>
  );
}

/**
 * Format a date as a readable string.
 */
function formatDate(date: Date): string {
  return date.toLocaleDateString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/**
 * Extract domain from URL for display.
 */
function getDomain(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

/**
 * Star icon component (filled or outline).
 */
function StarIcon({ filled }: { filled: boolean }) {
  if (filled) {
    return (
      <svg className="h-5 w-5" fill="currentColor" viewBox="0 0 20 20" aria-hidden="true">
        <path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z" />
      </svg>
    );
  }
  return (
    <svg
      className="h-5 w-5"
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth={1.5}
      aria-hidden="true"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M11.48 3.499a.562.562 0 011.04 0l2.125 5.111a.563.563 0 00.475.345l5.518.442c.499.04.701.663.321.988l-4.204 3.602a.563.563 0 00-.182.557l1.285 5.385a.562.562 0 01-.84.61l-4.725-2.885a.563.563 0 00-.586 0L6.982 20.54a.562.562 0 01-.84-.61l1.285-5.386a.562.562 0 00-.182-.557l-4.204-3.602a.563.563 0 01.321-.988l5.518-.442a.563.563 0 00.475-.345L11.48 3.5z"
      />
    </svg>
  );
}

/**
 * External link icon.
 */
function ExternalLinkIcon() {
  return (
    <svg
      className="h-4 w-4"
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth={2}
      aria-hidden="true"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"
      />
    </svg>
  );
}

/**
 * Back arrow icon.
 */
function BackArrowIcon() {
  return (
    <svg
      className="h-4 w-4"
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth={2}
      aria-hidden="true"
    >
      <path strokeLinecap="round" strokeLinejoin="round" d="M10 19l-7-7m0 0l7-7m-7 7h18" />
    </svg>
  );
}

/**
 * SavedArticleContent component.
 *
 * Fetches and displays the full content of a saved article.
 * Marks the article as read on mount.
 */
export function SavedArticleContent({ articleId, onBack }: SavedArticleContentProps) {
  const utils = trpc.useUtils();
  const hasMarkedRead = useRef(false);

  // Fetch the saved article
  const { data, isLoading, isError, error, refetch } = trpc.saved.get.useQuery({ id: articleId });

  // Mark read mutation
  const markReadMutation = trpc.saved.markRead.useMutation({
    onSuccess: () => {
      // Invalidate saved list and count to update read status
      utils.saved.list.invalidate();
      utils.saved.count.invalidate();
    },
  });

  // Star/unstar mutations
  const starMutation = trpc.saved.star.useMutation({
    onSuccess: () => {
      // Invalidate the article query to update starred status
      utils.saved.get.invalidate({ id: articleId });
      utils.saved.list.invalidate();
    },
  });

  const unstarMutation = trpc.saved.unstar.useMutation({
    onSuccess: () => {
      utils.saved.get.invalidate({ id: articleId });
      utils.saved.list.invalidate();
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

  const isStarLoading = starMutation.isPending || unstarMutation.isPending;

  // Loading state
  if (isLoading) {
    return <SavedArticleContentSkeleton />;
  }

  // Error state
  if (isError) {
    return (
      <SavedArticleContentError
        message={error?.message ?? "Failed to load article"}
        onRetry={() => refetch()}
      />
    );
  }

  // Article not found
  if (!article) {
    return <SavedArticleContentError message="Article not found" onRetry={() => refetch()} />;
  }

  // Prefer cleaned content if available, fall back to original
  const contentToDisplay = article.contentCleaned ?? article.contentOriginal;

  // Sanitize HTML content
  const sanitizedContent = contentToDisplay
    ? DOMPurify.sanitize(contentToDisplay, {
        // Allow safe tags and attributes
        ADD_TAGS: ["iframe"], // Allow iframes for embedded content
        ADD_ATTR: ["target", "allowfullscreen", "frameborder"], // Allow target="_blank" on links
        FORBID_TAGS: ["style", "script"], // Forbid style and script tags
        FORBID_ATTR: ["onerror", "onload", "onclick", "onmouseover"], // Forbid event handlers
      })
    : null;

  const displayTitle = article.title ?? "Untitled";
  const displaySite = article.siteName ?? getDomain(article.url);

  return (
    <article className="mx-auto max-w-3xl px-4 py-6 sm:py-8">
      {/* Back button */}
      {onBack && (
        <button
          onClick={onBack}
          className="mb-4 -ml-2 inline-flex min-h-[44px] items-center gap-2 rounded-md px-2 text-sm text-zinc-600 transition-colors hover:bg-zinc-100 hover:text-zinc-900 active:bg-zinc-200 sm:mb-6 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100 dark:active:bg-zinc-700"
        >
          <BackArrowIcon />
          <span>Back to list</span>
        </button>
      )}

      {/* Header */}
      <header className="mb-6 sm:mb-8">
        {/* Title */}
        <h1 className="mb-3 text-xl leading-tight font-bold text-zinc-900 sm:mb-4 sm:text-2xl md:text-3xl dark:text-zinc-100">
          {displayTitle}
        </h1>

        {/* Meta row: Site, Author, Date */}
        <div className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-zinc-600 sm:mb-6 sm:gap-x-4 sm:gap-y-2 sm:text-sm dark:text-zinc-400">
          <span className="font-medium">{displaySite}</span>
          {article.author && (
            <>
              <span
                aria-hidden="true"
                className="hidden text-zinc-400 sm:inline dark:text-zinc-600"
              >
                |
              </span>
              <span className="hidden sm:inline">by {article.author}</span>
              <span className="sm:hidden">- {article.author}</span>
            </>
          )}
          <span aria-hidden="true" className="hidden text-zinc-400 sm:inline dark:text-zinc-600">
            |
          </span>
          <time dateTime={article.savedAt.toISOString()} className="basis-full sm:basis-auto">
            Saved {formatDate(article.savedAt)}
          </time>
        </div>

        {/* Action buttons */}
        <div className="flex flex-wrap gap-2 sm:gap-3">
          {/* Star button */}
          <Button
            variant={article.starred ? "primary" : "secondary"}
            size="sm"
            onClick={handleStarToggle}
            disabled={isStarLoading}
            className={
              article.starred
                ? "bg-amber-500 text-white hover:bg-amber-600 dark:bg-amber-500 dark:text-white dark:hover:bg-amber-600"
                : ""
            }
            aria-label={article.starred ? "Remove from starred" : "Add to starred"}
          >
            <StarIcon filled={article.starred} />
            <span className="ml-2">{article.starred ? "Starred" : "Star"}</span>
          </Button>

          {/* Original article link */}
          <Button
            variant="secondary"
            size="sm"
            onClick={() => window.open(article.url, "_blank", "noopener,noreferrer")}
            aria-label="Open original article in new tab"
          >
            <ExternalLinkIcon />
            <span className="ml-2">View Original</span>
          </Button>
        </div>
      </header>

      {/* Divider */}
      <hr className="mb-6 border-zinc-200 sm:mb-8 dark:border-zinc-700" />

      {/* Content */}
      {sanitizedContent ? (
        <div
          className="prose prose-zinc prose-sm sm:prose-base dark:prose-invert prose-headings:font-semibold prose-headings:text-zinc-900 dark:prose-headings:text-zinc-100 prose-a:text-blue-600 dark:prose-a:text-blue-400 prose-a:underline-offset-2 hover:prose-a:text-blue-700 dark:hover:prose-a:text-blue-300 prose-img:rounded-lg prose-img:shadow-md prose-pre:overflow-x-auto prose-pre:bg-zinc-100 dark:prose-pre:bg-zinc-800 prose-code:text-zinc-800 dark:prose-code:text-zinc-200 prose-blockquote:border-l-zinc-300 dark:prose-blockquote:border-l-zinc-600 prose-blockquote:text-zinc-600 dark:prose-blockquote:text-zinc-400 max-w-none"
          dangerouslySetInnerHTML={{ __html: sanitizedContent }}
        />
      ) : article.excerpt ? (
        <p className="text-base leading-relaxed text-zinc-700 dark:text-zinc-300">
          {article.excerpt}
        </p>
      ) : (
        <p className="text-zinc-500 italic dark:text-zinc-400">No content available.</p>
      )}

      {/* Footer with original link */}
      <footer className="mt-8 border-t border-zinc-200 pt-6 sm:mt-12 sm:pt-8 dark:border-zinc-700">
        <a
          href={article.url}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex min-h-[44px] items-center gap-2 text-sm font-medium text-blue-600 transition-colors hover:text-blue-700 active:text-blue-800 dark:text-blue-400 dark:hover:text-blue-300 dark:active:text-blue-200"
        >
          <ExternalLinkIcon />
          Read on {getDomain(article.url)}
        </a>
      </footer>
    </article>
  );
}
