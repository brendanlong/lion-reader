/**
 * EntryArticle Component (SSR-safe)
 *
 * Pure presentational component for rendering an article.
 * Extracted from EntryContentBody to be SSR-compatible (no "use client").
 * Interactive features (narration, summarization, etc.) are passed
 * as slots from client components.
 */

import { type ReactNode, type CSSProperties, type RefObject } from "react";
import { ExternalLinkIcon } from "@/components/ui/icon-button";
import { getDomain } from "@/lib/format";
import { formatDate } from "./EntryContentHelpers";
import { EntryContentRenderer } from "./EntryContentRenderer";
import { ContentSkeleton } from "./EntryContentStates";

export interface EntryArticleProps {
  /** The article title */
  title: string;
  /** The article URL (null for email entries without a URL) */
  url: string | null;
  /** The source name (feed title or site name) */
  source: string;
  /** The article author */
  author: string | null;
  /** The date to display */
  date: Date;
  /** Optional prefix for the date (e.g., "Saved") */
  datePrefix?: string;
  /** Pre-sanitized HTML content */
  contentHtml: string | null;
  /** Fallback text content (summary or excerpt) */
  fallbackContent: string | null;
  /** CSS class for text size (from useEntryTextStyles or default) */
  textSizeClass?: string;
  /** Inline style for text appearance */
  textStyle?: CSSProperties;
  /** Optional domain for footer link (defaults to extracting from url) */
  footerLinkDomain?: string;
  /** Unsubscribe URL extracted from email newsletter (null for non-email entries) */
  unsubscribeUrl?: string | null;
  /** Whether content is loading (shows skeleton) */
  isContentLoading?: boolean;
  /** Ref for the content container (for highlighting, image prefetch) */
  contentRef?: RefObject<HTMLDivElement | null>;
  // Slots for interactive client components
  /** Back button slot (has onClick) */
  backButton?: ReactNode;
  /** Action buttons slot (star, read, narration, summarize buttons) */
  actionButtons?: ReactNode;
  /** Content inserted before the main article content (e.g., summary card, narration highlight styles) */
  beforeContent?: ReactNode;
  /** Content inserted after the article content (e.g., CTA buttons in demo) */
  afterContent?: ReactNode;
  /** Sticky controls that appear when the main action buttons scroll out of view */
  stickyControls?: ReactNode;
  /** Touch event handlers for swipe gestures */
  onTouchStart?: React.TouchEventHandler;
  onTouchEnd?: React.TouchEventHandler;
  onTouchCancel?: React.TouchEventHandler;
}

export function EntryArticle({
  title,
  url,
  source,
  author,
  date,
  datePrefix,
  contentHtml,
  fallbackContent,
  textSizeClass = "prose prose-zinc dark:prose-invert",
  textStyle,
  footerLinkDomain,
  unsubscribeUrl,
  isContentLoading,
  contentRef,
  backButton,
  actionButtons,
  beforeContent,
  afterContent,
  stickyControls,
  onTouchStart,
  onTouchEnd,
  onTouchCancel,
}: EntryArticleProps) {
  const displayFooterDomain = footerLinkDomain ?? (url ? getDomain(url) : "original site");

  return (
    <article
      className="mx-auto max-w-3xl px-4 py-6 sm:py-8"
      onTouchStart={onTouchStart}
      onTouchEnd={onTouchEnd}
      onTouchCancel={onTouchCancel}
    >
      {/* Back button slot */}
      {backButton}

      {/* Header */}
      <header className="mb-6 sm:mb-8">
        {/* Title and meta */}
        <div className="mb-4 sm:mb-6">
          {/* Title */}
          <div className="mb-2">
            {url ? (
              <a
                href={url}
                target="_blank"
                rel="noopener noreferrer"
                className="ui-text-xl sm:ui-text-2xl hover:text-accent text-strong block leading-tight font-bold transition-colors md:text-3xl"
              >
                {title}
              </a>
            ) : (
              <h1 className="ui-text-xl sm:ui-text-2xl text-strong leading-tight font-bold md:text-3xl">
                {title}
              </h1>
            )}
          </div>

          {/* Meta row: Source, Author, Date */}
          <div className="ui-text-xs sm:ui-text-sm text-muted flex flex-wrap items-center gap-x-3 gap-y-1 sm:gap-x-4 sm:gap-y-2">
            <span className="font-medium">{source}</span>
            {author && author.toLowerCase().trim() !== source.toLowerCase().trim() && (
              <>
                <span aria-hidden="true" className="text-faint hidden sm:inline">
                  |
                </span>
                <span className="hidden sm:inline">by {author}</span>
                <span className="sm:hidden">- {author}</span>
              </>
            )}
            <span aria-hidden="true" className="text-faint hidden sm:inline">
              |
            </span>
            <time dateTime={date.toISOString()} className="basis-full sm:basis-auto">
              {datePrefix ? `${datePrefix} ` : ""}
              {formatDate(date)}
            </time>
          </div>
        </div>

        {/* Action buttons slot */}
        {actionButtons}
      </header>

      {/* Divider */}
      <hr className="border-edge-strong mb-6 sm:mb-8" />

      {/* Before content slot (summary card, narration highlight styles) */}
      {beforeContent}

      {/* Content - show skeleton during progressive loading, otherwise render content */}
      {isContentLoading ? (
        <ContentSkeleton />
      ) : (
        <EntryContentRenderer
          sanitizedContent={contentHtml}
          fallbackContent={fallbackContent}
          contentRef={contentRef ?? { current: null }}
          textSizeClass={textSizeClass}
          textStyle={textStyle ?? {}}
        />
      )}

      {/* After content slot (CTA buttons, etc.) */}
      {afterContent}

      {/* Footer with original link and unsubscribe link */}
      {(url || unsubscribeUrl) && (
        <footer className="border-edge-strong mt-8 border-t pt-6 sm:mt-12 sm:pt-8">
          <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
            {url && (
              <a
                href={url}
                target="_blank"
                rel="noopener noreferrer"
                className="ui-text-sm text-accent hover:text-accent-hover inline-flex min-h-[44px] items-center gap-2 font-medium transition-colors"
              >
                <ExternalLinkIcon className="h-4 w-4" />
                Read on {displayFooterDomain}
              </a>
            )}
            {unsubscribeUrl && (
              <a
                href={unsubscribeUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="ui-text-sm text-muted hover:text-body inline-flex min-h-[44px] items-center gap-2 font-medium transition-colors active:text-zinc-800 dark:active:text-zinc-200"
              >
                <ExternalLinkIcon className="h-4 w-4" />
                Unsubscribe
              </a>
            )}
          </div>
        </footer>
      )}

      {/* Sticky controls slot - shown when main action buttons scroll out of view */}
      {stickyControls}
    </article>
  );
}
