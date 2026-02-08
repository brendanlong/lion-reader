/**
 * EntryContentBody Component
 *
 * Shared component for displaying entry content.
 * Used by EntryContent for all entry types (web, email, saved).
 */

"use client";

import { useEffect, useRef, useMemo, useCallback } from "react";
import { useHotkeys } from "react-hotkeys-hook";
import DOMPurify from "isomorphic-dompurify";

// Configure DOMPurify to:
// 1. Open all external links in new tabs
// 2. Lazy load all images
// This hook runs after each element is sanitized
DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  // Add target="_blank" for external links
  if (node.tagName === "A" && node.hasAttribute("href")) {
    const href = node.getAttribute("href") ?? "";
    // Only add target="_blank" for http/https links (external links)
    if (href.startsWith("http://") || href.startsWith("https://")) {
      node.setAttribute("target", "_blank");
      node.setAttribute("rel", "noopener noreferrer");
    }
  }

  // Lazy load all images
  if (node.tagName === "IMG") {
    node.setAttribute("loading", "lazy");
  }
});
import {
  Button,
  StarIcon,
  StarFilledIcon,
  CircleIcon,
  CircleFilledIcon,
  SpinnerIcon,
  SparklesIcon,
  AlertIcon,
  ArrowLeftIcon,
} from "@/components/ui";
import { SummaryCard } from "@/components/summarization";
import {
  NarrationControls,
  NarrationHighlightStyles,
  useNarration,
  useNarrationHighlight,
} from "@/components/narration";
import { processHtmlForHighlighting } from "@/lib/narration/client-paragraph-ids";
import { useNarrationSettings } from "@/lib/narration/settings";
import { useEntryTextStyles } from "@/lib/appearance";
import { useImagePrefetch } from "@/lib/hooks";
import { SWIPE_CONFIG } from "./EntryContentHelpers";
import { EntryArticle } from "./EntryArticle";
import { VoteControls } from "./VoteControls";

/**
 * Props for the EntryContentBody component.
 */
export interface EntryContentBodyProps {
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
  /** Optional domain for footer link (defaults to extracting from url) */
  footerLinkDomain?: string;
  /** Callback when swiping to next article */
  onSwipeNext?: () => void;
  /** Callback when swiping to previous article */
  onSwipePrevious?: () => void;
  // Full content fields
  /** Full content original HTML (fetched from URL) */
  fullContentOriginal?: string | null;
  /** Full content cleaned HTML (fetched from URL), null if Readability was skipped */
  fullContentCleaned?: string | null;
  /** Whether full content has been fetched */
  fullContentFetchedAt?: Date | null;
  /** Error message if full content fetch failed */
  fullContentError?: string | null;
  /** Whether to use full content (subscription setting) */
  fetchFullContent?: boolean;
  /** Whether full content is currently being fetched */
  isFullContentFetching?: boolean;
  /** Callback to toggle full content setting for subscription */
  onToggleFetchFullContent?: () => void;
  // Summarization fields
  /** Whether AI summarization is available */
  isSummarizationAvailable?: boolean;
  /** The generated summary, if any */
  summary?: {
    text: string;
    modelId: string;
    generatedAt: Date | null;
    settingsChanged: boolean;
  } | null;
  /** Whether to show the summary card */
  showSummary?: boolean;
  /** Error message if summarization failed */
  summaryError?: string | null;
  /** Whether summarization is in progress */
  isSummarizing?: boolean;
  /** Callback when summarize button is clicked */
  onSummarize?: () => void;
  /** Callback when summary close button is clicked */
  onSummaryClose?: () => void;
  /** Callback when regenerate summary is clicked */
  onSummaryRegenerate?: () => void;
  /** Whether the main content is still loading (for progressive rendering) */
  isContentLoading?: boolean;
  /** Whether to hide narration controls (e.g., in demo mode) */
  hideNarration?: boolean;
  // Score fields
  /** The explicit score (null if not voted) */
  score?: number | null;
  /** The implicit score (computed from actions) */
  implicitScore?: number;
  /** Callback when vote score changes */
  onSetScore?: (score: number | null) => void;
}

/**
 * Shared component for rendering entry content with narration highlighting.
 * Used by EntryContent for all entry types.
 */
export function EntryContentBody({
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
  footerLinkDomain,
  onSwipeNext,
  onSwipePrevious,
  // Full content props
  fullContentOriginal,
  fullContentCleaned,
  fullContentFetchedAt,
  fullContentError,
  fetchFullContent,
  isFullContentFetching,
  onToggleFetchFullContent,
  // Summarization props
  isSummarizationAvailable,
  summary,
  showSummary,
  summaryError,
  isSummarizing,
  onSummarize,
  onSummaryClose,
  onSummaryRegenerate,
  // Progressive loading
  isContentLoading,
  // Narration toggle
  hideNarration,
  // Score props
  score,
  implicitScore,
  onSetScore,
}: EntryContentBodyProps) {
  const contentRef = useRef<HTMLDivElement>(null);
  const touchStartRef = useRef<{ x: number; y: number } | null>(null);

  // Determine if we're showing full content
  // Full content is shown if:
  // 1. User has fetchFullContent enabled for the subscription
  // 2. Full content has been fetched successfully (no error, has content)
  const hasFullContent = Boolean(
    (fullContentCleaned || fullContentOriginal) && fullContentFetchedAt && !fullContentError
  );
  const showFullContent = fetchFullContent && hasFullContent;

  // Check if both feed content versions are available for toggle
  // Only show this toggle when NOT showing full content
  const hasBothVersions = Boolean(contentCleaned && contentOriginal) && !showFullContent;

  // Select content based on state
  // Priority: full content (if enabled and available) > cleaned feed content > original feed content
  let contentToDisplay: string | null;
  if (showFullContent) {
    contentToDisplay = fullContentCleaned ?? fullContentOriginal ?? null;
  } else if (showOriginal) {
    contentToDisplay = contentOriginal;
  } else {
    contentToDisplay = contentCleaned ?? contentOriginal;
  }

  // Set up narration with highlighting support
  const narration = useNarration({
    id: articleId,
    title,
    feedTitle: source,
    content: contentToDisplay,
  });

  const { highlightedParagraphIds } = useNarrationHighlight({
    currentParagraphIndex: narration.state.currentParagraph,
    isPlaying: narration.state.status === "playing",
  });

  // Get narration settings for auto-scroll preference
  const [narrationSettings] = useNarrationSettings();

  // Get text appearance settings
  const { className: textSizeClass, style: textStyle } = useEntryTextStyles();

  // Determine if we should process HTML for highlighting
  // We process it whenever narration has been activated (processedHtml exists or state is not idle)
  const shouldProcessForHighlighting =
    narration.isSupported &&
    (narration.processedHtml !== null || narration.state.status !== "idle");

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
        ADD_ATTR: ["target", "allowfullscreen", "frameborder", "data-para-id", "loading"],
        FORBID_TAGS: ["style", "script"],
        FORBID_ATTR: ["onerror", "onload", "onclick", "onmouseover"],
      });
    }

    const sanitized = DOMPurify.sanitize(contentToDisplay, {
      // Allow safe tags and attributes, plus data-para-id for highlighting
      ADD_TAGS: ["iframe"],
      ADD_ATTR: ["target", "allowfullscreen", "frameborder", "data-para-id", "loading"],
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

  // Prefetch images before they scroll into view
  // This prevents the flash that occurs with native loading="lazy"
  useImagePrefetch(contentRef, sanitizedContent);

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
      if (Math.abs(deltaY) > SWIPE_CONFIG.MAX_VERTICAL_DISTANCE) {
        return;
      }

      // Check if horizontal movement meets threshold
      if (Math.abs(deltaX) < SWIPE_CONFIG.SWIPE_THRESHOLD) {
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

  return (
    <EntryArticle
      title={title}
      url={url}
      source={source}
      author={author}
      date={date}
      datePrefix={datePrefix}
      contentHtml={sanitizedContent}
      fallbackContent={fallbackContent}
      textSizeClass={textSizeClass}
      textStyle={textStyle}
      footerLinkDomain={footerLinkDomain}
      isContentLoading={isContentLoading}
      contentRef={contentRef}
      onTouchStart={handleTouchStart}
      onTouchEnd={handleTouchEnd}
      backButton={
        onBack ? (
          <button
            onClick={onBack}
            className="ui-text-sm mb-4 -ml-2 inline-flex min-h-[44px] items-center gap-2 rounded-md px-2 text-zinc-600 transition-colors hover:bg-zinc-100 hover:text-zinc-900 active:bg-zinc-200 sm:mb-6 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100 dark:active:bg-zinc-700"
          >
            <ArrowLeftIcon className="h-4 w-4" />
            <span>Back to list</span>
          </button>
        ) : undefined
      }
      voteControls={
        onSetScore ? (
          <div className="-mt-[24px] shrink-0">
            <VoteControls
              score={score ?? null}
              implicitScore={implicitScore ?? 0}
              onSetScore={onSetScore}
            />
          </div>
        ) : undefined
      }
      actionButtons={
        <div className="flex flex-wrap items-center gap-2 sm:gap-3">
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
            {starred ? <StarFilledIcon className="h-5 w-5" /> : <StarIcon className="h-5 w-5" />}
            <span className="ml-2">{starred ? "Starred" : "Star"}</span>
          </Button>

          {/* Mark read/unread button */}
          <Button
            variant={!read ? "primary" : "secondary"}
            size="sm"
            onClick={onToggleRead}
            aria-label={read ? "Mark as unread" : "Mark as read"}
            title="Keyboard shortcut: m"
          >
            {read ? <CircleIcon className="h-4 w-4" /> : <CircleFilledIcon className="h-4 w-4" />}
            <span className="ml-2">{read ? "Read" : "Unread"}</span>
          </Button>

          {/* Content view toggle - only show when both versions exist and not showing full content */}
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

          {/* Full content toggle - shows when URL exists */}
          {url && onToggleFetchFullContent && (
            <Button
              variant={fullContentError ? "secondary" : fetchFullContent ? "primary" : "secondary"}
              size="sm"
              onClick={onToggleFetchFullContent}
              disabled={isFullContentFetching}
              className={
                fullContentError
                  ? "border-red-300 text-red-600 hover:bg-red-50 dark:border-red-700 dark:text-red-400 dark:hover:bg-red-950"
                  : fetchFullContent
                    ? "bg-blue-500 text-white hover:bg-blue-600 dark:bg-blue-500 dark:text-white dark:hover:bg-blue-600"
                    : ""
              }
              aria-label={
                fullContentError
                  ? `Retry fetching full content (previous error: ${fullContentError})`
                  : fetchFullContent
                    ? "Switch to feed content"
                    : "Fetch and display full article content"
              }
              title={fullContentError ? `Error: ${fullContentError}` : undefined}
            >
              {isFullContentFetching ? (
                <>
                  <SpinnerIcon className="h-4 w-4" />
                  <span className="ml-2">Fetching...</span>
                </>
              ) : fullContentError ? (
                <>
                  <AlertIcon className="h-4 w-4" />
                  <span className="ml-2">Retry Fetch</span>
                </>
              ) : (
                <span>Full Content</span>
              )}
            </Button>
          )}

          {/* Narration controls - pass narration state for controlled mode */}
          {!hideNarration && (
            <NarrationControls
              articleId={articleId}
              title={title}
              feedTitle={source}
              narration={narration}
            />
          )}

          {/* Summarize button */}
          {isSummarizationAvailable && onSummarize && (
            <Button
              variant={showSummary && summary ? "primary" : "secondary"}
              size="sm"
              onClick={onSummarize}
              disabled={isSummarizing}
              className={
                showSummary && summary
                  ? "bg-blue-500 text-white hover:bg-blue-600 dark:bg-blue-500 dark:text-white dark:hover:bg-blue-600"
                  : ""
              }
              aria-label={summary ? "Toggle summary" : "Generate AI summary"}
            >
              {isSummarizing ? (
                <>
                  <SpinnerIcon className="h-4 w-4" />
                  <span className="ml-2">Summarizing...</span>
                </>
              ) : summary ? (
                <>
                  <SparklesIcon className="h-4 w-4" />
                  <span className="ml-2">{showSummary ? "Hide Summary" : "Show Summary"}</span>
                </>
              ) : (
                <>
                  <SparklesIcon className="h-4 w-4" />
                  <span className="ml-2">Summarize</span>
                </>
              )}
            </Button>
          )}
        </div>
      }
      beforeContent={
        <>
          {/* Summary card - shown above content when available */}
          {showSummary && (summary || summaryError || isSummarizing) && (
            <SummaryCard
              summary={summary?.text ?? ""}
              modelId={summary?.modelId ?? ""}
              generatedAt={summary?.generatedAt ?? null}
              isLoading={isSummarizing}
              error={summaryError}
              onClose={onSummaryClose}
              onRegenerate={
                summaryError || summary?.settingsChanged ? onSummaryRegenerate : undefined
              }
            />
          )}

          {/* Dynamic highlight styles - CSS-based approach instead of DOM manipulation */}
          {!hideNarration && shouldProcessForHighlighting && (
            <NarrationHighlightStyles
              highlightedParagraphIds={highlightedParagraphIds}
              enabled={narrationSettings.highlightEnabled}
            />
          )}
        </>
      }
    />
  );
}
