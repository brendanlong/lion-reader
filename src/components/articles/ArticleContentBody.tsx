/**
 * ArticleContentBody Component
 *
 * Shared component for displaying article content.
 * Used by both EntryContent (feed entries) and SavedArticleContent (saved articles).
 */

"use client";

import { useEffect, useRef, useMemo, useCallback } from "react";
import { useHotkeys } from "react-hotkeys-hook";
import DOMPurify from "dompurify";
import { Button } from "@/components/ui/button";
import {
  NarrationControls,
  NarrationHighlightStyles,
  useNarration,
  useNarrationHighlight,
} from "@/components/narration";
import { isNarrationSupported } from "@/lib/narration/feature-detection";
import { processHtmlForHighlighting } from "@/lib/narration/client-paragraph-ids";
import { useNarrationSettings } from "@/lib/narration/settings";

/**
 * Format a date as a readable string.
 */
export function formatDate(date: Date): string {
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
export function getDomain(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

/**
 * Star icon component (filled or outline).
 */
export function StarIcon({ filled }: { filled: boolean }) {
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
 * Read/Unread indicator icon.
 * Filled circle for unread, empty circle for read.
 */
export function ReadStatusIcon({ read }: { read: boolean }) {
  if (read) {
    // Empty circle for read
    return (
      <svg
        className="h-4 w-4"
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
        strokeWidth={2}
        aria-hidden="true"
      >
        <circle cx="12" cy="12" r="9" />
      </svg>
    );
  }
  // Filled circle for unread
  return (
    <svg className="h-4 w-4" fill="currentColor" viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
    </svg>
  );
}

/**
 * External link icon.
 */
export function ExternalLinkIcon() {
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
export function BackArrowIcon() {
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
 * Loading skeleton for article content.
 */
export function ArticleContentSkeleton() {
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
 * Error state component for article content.
 */
export function ArticleContentError({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
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
 * Props for the ArticleContentBody component.
 */
export interface ArticleContentBodyProps {
  /** The unique identifier for the article */
  articleId: string;
  /** The article title */
  title: string;
  /** The source name (feed title or site name) */
  source: string;
  /** The article author */
  author: string | null;
  /** The article URL */
  url: string | null;
  /** The date to display */
  date: Date;
  /** Optional prefix for the date (e.g., "Saved") */
  datePrefix?: string;
  /** The original HTML content */
  contentOriginal: string | null;
  /** The cleaned HTML content */
  contentCleaned: string | null;
  /** Fallback text content (summary or excerpt) */
  fallbackContent: string | null;
  /** Whether the article has been read */
  read: boolean;
  /** Whether the article is starred */
  starred: boolean;
  /** Callback when back button is clicked */
  onBack?: () => void;
  /** Callback to toggle read status */
  onToggleRead: () => void;
  /** Callback to toggle star status */
  onToggleStar: () => void;
  /** Whether to show original content */
  showOriginal: boolean;
  /** Callback to set show original state */
  setShowOriginal: (show: boolean) => void;
  /** The article type for narration */
  narrationArticleType: "entry" | "saved";
  /** Optional domain for footer link (defaults to extracting from url) */
  footerLinkDomain?: string;
  /** Callback when swiping to next article */
  onSwipeNext?: () => void;
  /** Callback when swiping to previous article */
  onSwipePrevious?: () => void;
}

/**
 * Shared component for rendering article content with narration highlighting.
 * Used by both EntryContent and SavedArticleContent.
 */
// Swipe gesture configuration
const SWIPE_THRESHOLD = 50; // Minimum horizontal distance for swipe
const MAX_VERTICAL_DISTANCE = 100; // Maximum vertical movement allowed

export function ArticleContentBody({
  articleId,
  title,
  source,
  author,
  url,
  date,
  datePrefix,
  contentOriginal,
  contentCleaned,
  fallbackContent,
  read,
  starred,
  onBack,
  onToggleRead,
  onToggleStar,
  showOriginal,
  setShowOriginal,
  narrationArticleType,
  footerLinkDomain,
  onSwipeNext,
  onSwipePrevious,
}: ArticleContentBodyProps) {
  const contentRef = useRef<HTMLDivElement>(null);
  const touchStartRef = useRef<{ x: number; y: number } | null>(null);

  // Check if both content versions are available for toggle
  const hasBothVersions = Boolean(contentCleaned && contentOriginal);

  // Select content based on toggle state
  const contentToDisplay = showOriginal ? contentOriginal : (contentCleaned ?? contentOriginal);

  // Set up narration with highlighting support
  const narrationSupported = isNarrationSupported();
  const narration = useNarration({
    id: articleId,
    type: narrationArticleType,
    title,
    feedTitle: source,
    content: contentToDisplay,
  });

  const { highlightedParagraphIds } = useNarrationHighlight({
    paragraphMap: null,
    currentParagraphIndex: narration.state.currentParagraph,
    isPlaying: narration.state.status === "playing",
  });

  // Get narration settings for auto-scroll preference
  const [narrationSettings] = useNarrationSettings();

  // Determine if we should process HTML for highlighting
  // We process it whenever narration has been activated (processedHtml exists or state is not idle)
  const shouldProcessForHighlighting =
    narrationSupported && (narration.processedHtml !== null || narration.state.status !== "idle");

  // Sanitize and optionally process HTML content for highlighting
  const sanitizedContent = useMemo(() => {
    if (!contentToDisplay) return null;

    // If we have processed HTML from client-side narration, use it directly
    // This ensures the data-para-id attributes exactly match the paragraph mapping
    if (shouldProcessForHighlighting && narration.processedHtml) {
      // The processed HTML already has data-para-id attributes added during
      // htmlToClientNarration, so we just need to sanitize it
      return DOMPurify.sanitize(narration.processedHtml, {
        ADD_TAGS: ["iframe"],
        ADD_ATTR: ["target", "allowfullscreen", "frameborder", "data-para-id"],
        FORBID_TAGS: ["style", "script"],
        FORBID_ATTR: ["onerror", "onload", "onclick", "onmouseover"],
      });
    }

    const sanitized = DOMPurify.sanitize(contentToDisplay, {
      // Allow safe tags and attributes, plus data-para-id for highlighting
      ADD_TAGS: ["iframe"],
      ADD_ATTR: ["target", "allowfullscreen", "frameborder", "data-para-id"],
      FORBID_TAGS: ["style", "script"],
      FORBID_ATTR: ["onerror", "onload", "onclick", "onmouseover"],
    });

    // Process for highlighting if narration is active (server-side narration path)
    // For client-side narration, we use processedHtml above
    if (shouldProcessForHighlighting) {
      return processHtmlForHighlighting(sanitized);
    }

    return sanitized;
  }, [contentToDisplay, shouldProcessForHighlighting, narration.processedHtml]);

  // Auto-scroll to highlighted paragraph when playing
  // Note: Highlighting is now handled via CSS by NarrationHighlightStyles component
  useEffect(() => {
    if (!contentRef.current || !shouldProcessForHighlighting) return;
    if (!narrationSettings.autoScrollEnabled) return;
    if (narration.state.status !== "playing") return;
    if (highlightedParagraphIds.size === 0) return;

    // Find the first highlighted element for scrolling
    const container = contentRef.current;
    const firstIndex = Math.min(...highlightedParagraphIds);
    const element = container.querySelector(
      `[data-para-id="para-${firstIndex}"]`
    ) as HTMLElement | null;

    if (!element) return;

    // Check if element is already in viewport
    const rect = element.getBoundingClientRect();
    // Account for the header (scroll-margin-top is 100px in CSS)
    const headerHeight = 100;
    const isInViewport = rect.top >= headerHeight && rect.bottom <= window.innerHeight;

    if (!isInViewport) {
      element.scrollIntoView({
        behavior: "smooth",
        block: "center",
      });
    }
  }, [
    highlightedParagraphIds,
    shouldProcessForHighlighting,
    narrationSettings.autoScrollEnabled,
    narration.state.status,
  ]);

  // Swipe gesture handlers
  const swipeEnabled = Boolean(onSwipeNext || onSwipePrevious);

  const handleTouchStart = useCallback(
    (e: React.TouchEvent) => {
      if (!swipeEnabled) return;
      const touch = e.touches[0];
      touchStartRef.current = { x: touch.clientX, y: touch.clientY };
    },
    [swipeEnabled]
  );

  const handleTouchEnd = useCallback(
    (e: React.TouchEvent) => {
      if (!swipeEnabled || !touchStartRef.current) return;

      const touch = e.changedTouches[0];
      const deltaX = touch.clientX - touchStartRef.current.x;
      const deltaY = touch.clientY - touchStartRef.current.y;

      // Reset touch start
      touchStartRef.current = null;

      // Check if vertical movement is too large (user is scrolling, not swiping)
      if (Math.abs(deltaY) > MAX_VERTICAL_DISTANCE) {
        return;
      }

      // Check if horizontal movement meets threshold
      if (Math.abs(deltaX) < SWIPE_THRESHOLD) {
        return;
      }

      // Determine swipe direction
      if (deltaX < 0 && onSwipeNext) {
        // Swipe left -> next entry
        onSwipeNext();
      } else if (deltaX > 0 && onSwipePrevious) {
        // Swipe right -> previous entry
        onSwipePrevious();
      }
    },
    [swipeEnabled, onSwipeNext, onSwipePrevious]
  );

  // Keyboard shortcut: m to toggle read/unread
  useHotkeys(
    "m",
    (e) => {
      e.preventDefault();
      onToggleRead();
    },
    {
      enableOnFormTags: false,
    },
    [onToggleRead]
  );

  // Determine footer link domain
  const displayFooterDomain = footerLinkDomain ?? (url ? getDomain(url) : "original site");

  return (
    <article
      className="mx-auto max-w-3xl px-4 py-6 sm:py-8"
      onTouchStart={handleTouchStart}
      onTouchEnd={handleTouchEnd}
    >
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
          {title}
        </h1>

        {/* Meta row: Source, Author, Date */}
        <div className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-zinc-600 sm:mb-6 sm:gap-x-4 sm:gap-y-2 sm:text-sm dark:text-zinc-400">
          <span className="font-medium">{source}</span>
          {author && (
            <>
              <span
                aria-hidden="true"
                className="hidden text-zinc-400 sm:inline dark:text-zinc-600"
              >
                |
              </span>
              <span className="hidden sm:inline">by {author}</span>
              <span className="sm:hidden">- {author}</span>
            </>
          )}
          <span aria-hidden="true" className="hidden text-zinc-400 sm:inline dark:text-zinc-600">
            |
          </span>
          <time dateTime={date.toISOString()} className="basis-full sm:basis-auto">
            {datePrefix ? `${datePrefix} ` : ""}
            {formatDate(date)}
          </time>
        </div>

        {/* Action buttons */}
        <div className="flex flex-wrap gap-2 sm:gap-3">
          {/* Star button */}
          <Button
            variant={starred ? "primary" : "secondary"}
            size="sm"
            onClick={onToggleStar}
            className={
              starred
                ? "bg-amber-500 text-white hover:bg-amber-600 dark:bg-amber-500 dark:text-white dark:hover:bg-amber-600"
                : ""
            }
            aria-label={starred ? "Remove from starred" : "Add to starred"}
          >
            <StarIcon filled={starred} />
            <span className="ml-2">{starred ? "Starred" : "Star"}</span>
          </Button>

          {/* Mark read/unread button */}
          <Button
            variant="secondary"
            size="sm"
            onClick={onToggleRead}
            aria-label={read ? "Mark as unread" : "Mark as read"}
            title="Keyboard shortcut: m"
          >
            <ReadStatusIcon read={read} />
            <span className="ml-2">{read ? "Mark Unread" : "Mark Read"}</span>
          </Button>

          {/* Content view toggle - only show when both versions exist */}
          {hasBothVersions && (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setShowOriginal(!showOriginal)}
              aria-label={showOriginal ? "Show cleaned content" : "Show original content"}
            >
              <span>{showOriginal ? "Show Cleaned" : "Show Original"}</span>
            </Button>
          )}

          {/* Original article link */}
          {url && (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => window.open(url, "_blank", "noopener,noreferrer")}
              aria-label="Open original article in new tab"
            >
              <ExternalLinkIcon />
              <span className="ml-2">View Original</span>
            </Button>
          )}

          {/* Narration controls - pass narration state for controlled mode */}
          <NarrationControls
            articleId={articleId}
            articleType={narrationArticleType}
            title={title}
            feedTitle={source}
            narration={narration}
          />
        </div>
      </header>

      {/* Divider */}
      <hr className="mb-6 border-zinc-200 sm:mb-8 dark:border-zinc-700" />

      {/* Dynamic highlight styles - CSS-based approach instead of DOM manipulation */}
      {shouldProcessForHighlighting && (
        <NarrationHighlightStyles
          highlightedParagraphIds={highlightedParagraphIds}
          enabled={narrationSettings.highlightEnabled}
        />
      )}

      {/* Content */}
      {sanitizedContent ? (
        <div
          ref={contentRef}
          className="prose prose-zinc prose-sm sm:prose-base dark:prose-invert prose-headings:font-semibold prose-headings:text-zinc-900 dark:prose-headings:text-zinc-100 prose-a:text-blue-600 dark:prose-a:text-blue-400 prose-a:underline-offset-2 hover:prose-a:text-blue-700 dark:hover:prose-a:text-blue-300 prose-img:rounded-lg prose-img:shadow-md prose-pre:overflow-x-auto prose-pre:bg-zinc-100 dark:prose-pre:bg-zinc-800 prose-code:text-zinc-800 dark:prose-code:text-zinc-200 prose-blockquote:border-l-zinc-300 dark:prose-blockquote:border-l-zinc-600 prose-blockquote:text-zinc-600 dark:prose-blockquote:text-zinc-400 max-w-none"
          dangerouslySetInnerHTML={{ __html: sanitizedContent }}
        />
      ) : fallbackContent ? (
        <p className="text-base leading-relaxed text-zinc-700 dark:text-zinc-300">
          {fallbackContent}
        </p>
      ) : (
        <p className="text-zinc-500 italic dark:text-zinc-400">No content available.</p>
      )}

      {/* Footer with original link */}
      {url && (
        <footer className="mt-8 border-t border-zinc-200 pt-6 sm:mt-12 sm:pt-8 dark:border-zinc-700">
          <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex min-h-[44px] items-center gap-2 text-sm font-medium text-blue-600 transition-colors hover:text-blue-700 active:text-blue-800 dark:text-blue-400 dark:hover:text-blue-300 dark:active:text-blue-200"
          >
            <ExternalLinkIcon />
            Read on {displayFooterDomain}
          </a>
        </footer>
      )}
    </article>
  );
}
