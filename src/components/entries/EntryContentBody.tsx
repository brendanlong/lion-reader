/**
 * EntryContentBody Component
 *
 * Shared component for displaying entry content.
 * Used by EntryContent for all entry types (web, email, saved).
 */

"use client";

import { useEffect, useRef, useMemo } from "react";
import { useHotkeys } from "react-hotkeys-hook";
import { Button } from "@/components/ui/button";
import { SpinnerIcon, SparklesIcon, AlertIcon, ArrowLeftIcon } from "@/components/ui/icon-button";
import { StarButton, ReadToggleButton } from "@/components/entries/EntryStateButtons";
import { SummaryCard } from "@/components/summarization/SummaryCard";
import { NarrationControls } from "@/components/narration";
import { NarrationHighlightStyles } from "@/components/narration/NarrationHighlightStyles";
import { useNarration } from "@/components/narration/useNarration";
import { useNarrationHighlight } from "@/components/narration/useNarrationHighlight";
import { processHtmlForHighlighting } from "@/lib/narration/client-paragraph-ids";
import { selectDisplayedContent } from "@/lib/narration/select-content";
import { useNarrationSettings } from "@/lib/narration/settings";
import { useEntryTextStyles } from "@/lib/appearance/AppearanceProvider";
import { useImagePrefetch } from "@/lib/hooks/useImagePrefetch";
import { useSwipeGesture } from "@/lib/hooks/useSwipeGesture";
import { EntryArticle } from "./EntryArticle";
import { StickyEntryControls } from "./StickyEntryControls";

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
  /** Unsubscribe URL extracted from email newsletter (null for non-email entries) */
  unsubscribeUrl?: string | null;
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
  unsubscribeUrl,
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
}: EntryContentBodyProps) {
  const contentRef = useRef<HTMLDivElement>(null);
  const actionButtonsRef = useRef<HTMLDivElement>(null);

  // Determine if we're showing full content
  // Full content is shown if:
  // 1. User has fetchFullContent enabled for the subscription
  // 2. Full content has been fetched successfully (no error, has content)
  const hasFullContent = Boolean(
    (fullContentCleaned || fullContentOriginal) && fullContentFetchedAt && !fullContentError
  );
  const showFullContent = Boolean(fetchFullContent && hasFullContent);

  // Check if both feed content versions are available for toggle
  // Only show this toggle when NOT showing full content
  const hasBothVersions = Boolean(contentCleaned && contentOriginal) && !showFullContent;

  // Select content based on state
  // Priority: full content (if enabled and available) > cleaned feed content > original feed content
  const contentToDisplay = selectDisplayedContent(
    { fullContentCleaned, fullContentOriginal, contentCleaned, contentOriginal },
    { showFullContent, showOriginal }
  );

  // Set up narration with highlighting support. Pass the current view state so
  // the server narrates (and maps highlights against) exactly the variant on
  // screen, not a fixed full/cleaned/original priority.
  const narration = useNarration({
    id: articleId,
    title,
    feedTitle: source,
    content: contentToDisplay,
    showFullContent,
    showOriginal,
  });

  const { highlightedParagraphIds } = useNarrationHighlight({
    currentParagraphIndex: narration.state.currentParagraph,
    isPlaying: narration.state.status === "playing",
  });

  // Get narration settings for auto-scroll preference
  const [narrationSettings] = useNarrationSettings();

  // Stop narration if user disables it in settings while audio is playing
  useEffect(() => {
    if (!narrationSettings.enabled) {
      narration.stop();
    }
    // Only trigger when enabled changes, not on every narration object change
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [narrationSettings.enabled]);

  // Get text appearance settings
  const { className: textSizeClass, style: textStyle } = useEntryTextStyles();

  // Determine if we should process HTML for highlighting
  // We process it whenever narration has been activated (processedHtml exists or state is not idle)
  const shouldProcessForHighlighting =
    narration.isSupported &&
    (narration.processedHtml !== null || narration.state.status !== "idle");

  // Content is sanitized on the server (src/server/html/sanitize.ts), so here we
  // only apply narration highlighting markup.
  const sanitizedContent = useMemo(() => {
    if (!contentToDisplay) return null;

    // Client-side narration produces processedHtml (with data-para-id) from the
    // already-sanitized content; use it directly so the highlight paragraph IDs
    // exactly match the mapping.
    if (shouldProcessForHighlighting && narration.processedHtml) {
      return narration.processedHtml;
    }

    // Server-side narration path: add highlighting wrappers to sanitized content.
    if (shouldProcessForHighlighting) {
      return processHtmlForHighlighting(contentToDisplay);
    }

    return contentToDisplay;
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

  const {
    onTouchStart: handleTouchStart,
    onTouchEnd: handleTouchEnd,
    onTouchCancel: handleTouchCancel,
  } = useSwipeGesture({
    onSwipeLeft: onSwipeNext,
    onSwipeRight: onSwipePrevious,
    enabled: Boolean(onSwipeNext || onSwipePrevious),
  });

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
      unsubscribeUrl={unsubscribeUrl}
      isContentLoading={isContentLoading}
      contentRef={contentRef}
      onTouchStart={handleTouchStart}
      onTouchEnd={handleTouchEnd}
      onTouchCancel={handleTouchCancel}
      backButton={
        onBack ? (
          <button
            onClick={onBack}
            className="ui-text-sm text-muted hover:bg-surface-muted hover:text-body mb-4 -ml-2 inline-flex min-h-[44px] items-center gap-2 rounded-md px-2 transition-colors active:bg-zinc-200 sm:mb-6 dark:active:bg-zinc-700"
          >
            <ArrowLeftIcon className="h-4 w-4" />
            <span>Back to list</span>
          </button>
        ) : undefined
      }
      actionButtons={
        <div ref={actionButtonsRef} className="flex flex-wrap items-center gap-2 sm:gap-3">
          {/* Star + Read/Unread toggles (shared with the fallback and demo readers) */}
          <StarButton starred={starred} onToggle={onToggleStar} />
          <ReadToggleButton read={read} onToggle={onToggleRead} />

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
                fullContentError ? "border-danger-border text-danger hover:bg-danger-subtle" : ""
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
          {!hideNarration && narrationSettings.enabled && (
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
          {!hideNarration && narrationSettings.enabled && shouldProcessForHighlighting && (
            <NarrationHighlightStyles
              highlightedParagraphIds={highlightedParagraphIds}
              enabled={narrationSettings.highlightEnabled}
            />
          )}
        </>
      }
      stickyControls={
        <StickyEntryControls
          actionButtonsRef={actionButtonsRef}
          starred={starred}
          read={read}
          onToggleStar={onToggleStar}
          onToggleRead={onToggleRead}
        />
      }
    />
  );
}
