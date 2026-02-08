/**
 * EntryArticle Component (SSR-safe)
 *
 * Pure presentational component for rendering an article.
 * Extracted from EntryContentBody to be SSR-compatible (no "use client").
 * Interactive features (narration, summarization, voting, etc.) are passed
 * as slots from client components.
 */

import { type ReactNode, type CSSProperties, type RefObject } from "react";
import { ExternalLinkIcon } from "@/components/ui";
import { formatDate, getDomain } from "./EntryContentHelpers";
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
  /** Whether content is loading (shows skeleton) */
  isContentLoading?: boolean;
  /** Ref for the content container (for highlighting, image prefetch) */
  contentRef?: RefObject<HTMLDivElement | null>;
  // Slots for interactive client components
  /** Back button slot (has onClick) */
  backButton?: ReactNode;
  /** Vote controls slot (score display on right side of title) */
  voteControls?: ReactNode;
  /** Action buttons slot (star, read, narration, summarize buttons) */
  actionButtons?: ReactNode;
  /** Content inserted before the main article content (e.g., summary card, narration highlight styles) */
  beforeContent?: ReactNode;
  /** Content inserted after the article content (e.g., CTA buttons in demo) */
  afterContent?: ReactNode;
  /** Touch event handlers for swipe gestures */
  onTouchStart?: React.TouchEventHandler;
  onTouchEnd?: React.TouchEventHandler;
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
  isContentLoading,
  contentRef,
  backButton,
  voteControls,
  actionButtons,
  beforeContent,
  afterContent,
  onTouchStart,
  onTouchEnd,
}: EntryArticleProps) {
  const displayFooterDomain = footerLinkDomain ?? (url ? getDomain(url) : "original site");

  return (
    <article
      className="mx-auto max-w-3xl px-4 py-6 sm:py-8"
      onTouchStart={onTouchStart}
      onTouchEnd={onTouchEnd}
    >
      {/* Back button slot */}
      {backButton}

      {/* Header */}
      <header className="mb-6 sm:mb-8">
        {/* Title row: title+meta on left, vote controls on right */}
        <div className="mb-4 flex gap-4 sm:mb-6">
          {/* Left column: title and meta */}
          <div className="min-w-0 flex-1">
            {/* Title */}
            <div className="mb-2">
              {url ? (
                <a
                  href={url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="ui-text-xl sm:ui-text-2xl block leading-tight font-bold text-zinc-900 underline-offset-2 transition-colors hover:text-blue-600 hover:underline md:text-3xl dark:text-zinc-100 dark:hover:text-blue-400"
                >
                  {title}
                </a>
              ) : (
                <h1 className="ui-text-xl sm:ui-text-2xl leading-tight font-bold text-zinc-900 md:text-3xl dark:text-zinc-100">
                  {title}
                </h1>
              )}
            </div>

            {/* Meta row: Source, Author, Date */}
            <div className="ui-text-xs sm:ui-text-sm flex flex-wrap items-center gap-x-3 gap-y-1 text-zinc-600 sm:gap-x-4 sm:gap-y-2 dark:text-zinc-400">
              <span className="font-medium">{source}</span>
              {author && author.toLowerCase().trim() !== source.toLowerCase().trim() && (
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
              <span
                aria-hidden="true"
                className="hidden text-zinc-400 sm:inline dark:text-zinc-600"
              >
                |
              </span>
              <time dateTime={date.toISOString()} className="basis-full sm:basis-auto">
                {datePrefix ? `${datePrefix} ` : ""}
                {formatDate(date)}
              </time>
            </div>
          </div>

          {/* Right column: vote controls slot */}
          {voteControls}
        </div>

        {/* Action buttons slot */}
        {actionButtons}
      </header>

      {/* Divider */}
      <hr className="mb-6 border-zinc-200 sm:mb-8 dark:border-zinc-700" />

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

      {/* Footer with original link */}
      {url && (
        <footer className="mt-8 border-t border-zinc-200 pt-6 sm:mt-12 sm:pt-8 dark:border-zinc-700">
          <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            className="ui-text-sm inline-flex min-h-[44px] items-center gap-2 font-medium text-blue-600 transition-colors hover:text-blue-700 active:text-blue-800 dark:text-blue-400 dark:hover:text-blue-300 dark:active:text-blue-200"
          >
            <ExternalLinkIcon className="h-4 w-4" />
            Read on {displayFooterDomain}
          </a>
        </footer>
      )}
    </article>
  );
}
