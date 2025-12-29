/**
 * EntryContent Component
 *
 * Displays the full content of a single entry.
 * Includes title, author, date, content (safely sanitized), star button,
 * and link to original article. Marks entry as read when viewed.
 */

"use client";

import { useEffect, useRef, useState, useMemo } from "react";
import { useHotkeys } from "react-hotkeys-hook";
import DOMPurify from "dompurify";
import { trpc } from "@/lib/trpc/client";
import { useEntryMutations } from "@/lib/hooks";
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
 * Props for the EntryContent component.
 */
interface EntryContentProps {
  /**
   * The ID of the entry to display.
   */
  entryId: string;

  /**
   * Optional callback when the back button is clicked.
   */
  onBack?: () => void;

  /**
   * Optional callback when read status should be toggled.
   * Receives the entry ID and its current read status.
   */
  onToggleRead?: (entryId: string, currentlyRead: boolean) => void;
}

/**
 * Loading skeleton for entry content.
 */
function EntryContentSkeleton() {
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
 * Error state component for entry content.
 */
function EntryContentError({ message, onRetry }: { message: string; onRetry: () => void }) {
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
 * Read/Unread indicator icon.
 * Filled circle for unread, empty circle for read.
 */
function ReadStatusIcon({ read }: { read: boolean }) {
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
 * Entry type from API response.
 * Matches the shape of data returned from entries.get query.
 */
interface EntryData {
  id: string;
  feedId: string;
  url: string | null;
  title: string | null;
  author: string | null;
  contentOriginal: string | null;
  contentCleaned: string | null;
  summary: string | null;
  publishedAt: Date | null;
  fetchedAt: Date;
  read: boolean;
  starred: boolean;
  feedTitle: string | null;
  feedUrl: string | null;
}

/**
 * Props for the inner EntryContentBody component.
 */
interface EntryContentBodyProps {
  entry: EntryData;
  entryId: string;
  onBack?: () => void;
  onToggleRead?: (entryId: string, currentlyRead: boolean) => void;
  showOriginal: boolean;
  setShowOriginal: (show: boolean) => void;
  handleStarToggle: () => void;
  isStarLoading: boolean;
}

/**
 * Inner component that renders entry content with narration highlighting.
 * Separated to allow proper hook usage after entry data is loaded.
 */
function EntryContentBody({
  entry,
  entryId,
  onBack,
  onToggleRead,
  showOriginal,
  setShowOriginal,
  handleStarToggle,
  isStarLoading,
}: EntryContentBodyProps) {
  const contentRef = useRef<HTMLDivElement>(null);

  const displayTitle = entry.title ?? "Untitled";
  const displayDate = entry.publishedAt ?? entry.fetchedAt;
  const displayFeed = entry.feedTitle ?? "Unknown Feed";

  // Check if both content versions are available for toggle
  const hasBothVersions = Boolean(entry.contentCleaned && entry.contentOriginal);

  // Select content based on toggle state
  const contentToDisplay = showOriginal
    ? entry.contentOriginal
    : (entry.contentCleaned ?? entry.contentOriginal);

  // Set up narration with highlighting support
  const narrationSupported = isNarrationSupported();
  const narration = useNarration({
    id: entryId,
    type: "entry",
    title: displayTitle,
    feedTitle: displayFeed,
    content: contentToDisplay,
  });

  const { highlightedParagraphIds } = useNarrationHighlight({
    paragraphMap: narration.paragraphMap,
    currentParagraphIndex: narration.state.currentParagraph,
    isPlaying: narration.state.status === "playing",
  });

  // Get narration settings for auto-scroll preference
  const [narrationSettings] = useNarrationSettings();

  // Determine if we should process HTML for highlighting
  // We process it whenever narration has been activated (paragraphMap exists or state is not idle)
  const shouldProcessForHighlighting =
    narrationSupported && (narration.paragraphMap !== null || narration.state.status !== "idle");

  // Sanitize and optionally process HTML content for highlighting
  const sanitizedContent = useMemo(() => {
    if (!contentToDisplay) return null;

    const sanitized = DOMPurify.sanitize(contentToDisplay, {
      // Allow safe tags and attributes, plus data-para-id for highlighting
      ADD_TAGS: ["iframe"],
      ADD_ATTR: ["target", "allowfullscreen", "frameborder", "data-para-id"],
      FORBID_TAGS: ["style", "script"],
      FORBID_ATTR: ["onerror", "onload", "onclick", "onmouseover"],
    });

    // Process for highlighting if narration is active
    if (shouldProcessForHighlighting) {
      return processHtmlForHighlighting(sanitized);
    }

    return sanitized;
  }, [contentToDisplay, shouldProcessForHighlighting]);

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

  // Handle read toggle
  const handleReadToggle = () => {
    if (!onToggleRead) return;
    onToggleRead(entryId, entry.read);
  };

  // Keyboard shortcut: m to toggle read/unread
  useHotkeys(
    "m",
    (e) => {
      e.preventDefault();
      handleReadToggle();
    },
    {
      enabled: !!onToggleRead,
      enableOnFormTags: false,
    },
    [onToggleRead, handleReadToggle]
  );

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

        {/* Meta row: Feed, Author, Date */}
        <div className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-zinc-600 sm:mb-6 sm:gap-x-4 sm:gap-y-2 sm:text-sm dark:text-zinc-400">
          <span className="font-medium">{displayFeed}</span>
          {entry.author && (
            <>
              <span
                aria-hidden="true"
                className="hidden text-zinc-400 sm:inline dark:text-zinc-600"
              >
                |
              </span>
              <span className="hidden sm:inline">by {entry.author}</span>
              <span className="sm:hidden">- {entry.author}</span>
            </>
          )}
          <span aria-hidden="true" className="hidden text-zinc-400 sm:inline dark:text-zinc-600">
            |
          </span>
          <time dateTime={displayDate.toISOString()} className="basis-full sm:basis-auto">
            {formatDate(displayDate)}
          </time>
        </div>

        {/* Action buttons */}
        <div className="flex flex-wrap gap-2 sm:gap-3">
          {/* Star button */}
          <Button
            variant={entry.starred ? "primary" : "secondary"}
            size="sm"
            onClick={handleStarToggle}
            disabled={isStarLoading}
            className={
              entry.starred
                ? "bg-amber-500 text-white hover:bg-amber-600 dark:bg-amber-500 dark:text-white dark:hover:bg-amber-600"
                : ""
            }
            aria-label={entry.starred ? "Remove from starred" : "Add to starred"}
          >
            <StarIcon filled={entry.starred} />
            <span className="ml-2">{entry.starred ? "Starred" : "Star"}</span>
          </Button>

          {/* Mark read/unread button */}
          {onToggleRead && (
            <Button
              variant="secondary"
              size="sm"
              onClick={handleReadToggle}
              aria-label={entry.read ? "Mark as unread" : "Mark as read"}
              title="Keyboard shortcut: m"
            >
              <ReadStatusIcon read={entry.read} />
              <span className="ml-2">{entry.read ? "Mark Unread" : "Mark Read"}</span>
            </Button>
          )}

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
          {entry.url && (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => window.open(entry.url!, "_blank", "noopener,noreferrer")}
              aria-label="Open original article in new tab"
            >
              <ExternalLinkIcon />
              <span className="ml-2">View Original</span>
            </Button>
          )}

          {/* Narration controls - pass narration state for controlled mode */}
          <NarrationControls
            articleId={entryId}
            articleType="entry"
            title={displayTitle}
            feedTitle={displayFeed}
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
      ) : entry.summary ? (
        <p className="text-base leading-relaxed text-zinc-700 dark:text-zinc-300">
          {entry.summary}
        </p>
      ) : (
        <p className="text-zinc-500 italic dark:text-zinc-400">No content available.</p>
      )}

      {/* Footer with original link */}
      {entry.url && (
        <footer className="mt-8 border-t border-zinc-200 pt-6 sm:mt-12 sm:pt-8 dark:border-zinc-700">
          <a
            href={entry.url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex min-h-[44px] items-center gap-2 text-sm font-medium text-blue-600 transition-colors hover:text-blue-700 active:text-blue-800 dark:text-blue-400 dark:hover:text-blue-300 dark:active:text-blue-200"
          >
            <ExternalLinkIcon />
            Read on {entry.feedUrl ? new URL(entry.feedUrl).hostname : "original site"}
          </a>
        </footer>
      )}
    </article>
  );
}

/**
 * EntryContent component.
 *
 * Fetches and displays the full content of an entry.
 * Marks the entry as read on mount.
 */
export function EntryContent({ entryId, onBack, onToggleRead }: EntryContentProps) {
  const hasMarkedRead = useRef(false);
  const [showOriginal, setShowOriginal] = useState(false);

  // Fetch the entry
  const { data, isLoading, isError, error, refetch } = trpc.entries.get.useQuery({ id: entryId });

  // Entry mutations without list filters (this component operates on a single entry)
  // Note: optimistic updates happen at the list level in parent components,
  // normy automatically propagates changes to entries.get when server responds
  const { markRead, star, unstar, isPending: isStarLoading } = useEntryMutations();

  const entry = data?.entry;

  // Mark entry as read when component mounts and entry is loaded (only once)
  useEffect(() => {
    if (entry && !hasMarkedRead.current) {
      hasMarkedRead.current = true;
      // Only mark as read if it's currently unread
      if (!entry.read) {
        markRead([entryId], true);
      }
    }
  }, [entry, entryId, markRead]);

  // Handle star toggle
  const handleStarToggle = () => {
    if (!entry) return;

    if (entry.starred) {
      unstar(entryId);
    } else {
      star(entryId);
    }
  };

  // Loading state
  if (isLoading) {
    return <EntryContentSkeleton />;
  }

  // Error state
  if (isError) {
    return (
      <EntryContentError
        message={error?.message ?? "Failed to load entry"}
        onRetry={() => refetch()}
      />
    );
  }

  // Entry not found
  if (!entry) {
    return <EntryContentError message="Entry not found" onRetry={() => refetch()} />;
  }

  // Render the entry content with narration support
  return (
    <EntryContentBody
      entry={entry}
      entryId={entryId}
      onBack={onBack}
      onToggleRead={onToggleRead}
      showOriginal={showOriginal}
      setShowOriginal={setShowOriginal}
      handleStarToggle={handleStarToggle}
      isStarLoading={isStarLoading}
    />
  );
}
