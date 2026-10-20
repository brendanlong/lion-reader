/**
 * EntryArticle Component (SSR-safe)
 *
 * Pure presentational component for rendering an article.
 * Extracted from EntryContentBody to be SSR-compatible (no "use client").
 * Interactive features (narration, summarization, etc.) are passed
 * as slots from client components.
 */

import { type ReactNode, type CSSProperties, type RefObject } from "react";
import { buttonClassName } from "@/components/ui/button";
import { ArrowLeftIcon, ExternalLinkIcon } from "@/components/ui/icons";
import { LocalTime } from "@/components/ui/local-time";
import { SkeletonText } from "@/components/ui/skeleton";
import { ENTRY_TEXT_STYLE } from "@/lib/appearance/config";
import { getDomain } from "@/lib/format";
import { formatDate } from "./EntryContentHelpers";
import { EntryContentRenderer } from "./EntryContentRenderer";

const DEFAULT_TEXT_SIZE_CLASS = "prose prose-zinc dark:prose-invert";
const ARTICLE_CLASSES = "mx-auto max-w-3xl px-4 py-6 sm:py-8";
const TITLE_TEXT_CLASSES =
  "ui-text-xl sm:ui-text-2xl text-body leading-tight font-bold md:text-3xl";
const META_ROW_CLASSES =
  "ui-text-xs sm:ui-text-sm text-muted flex flex-wrap items-center gap-x-3 gap-y-1 sm:gap-x-4 sm:gap-y-2";

/** Layout for the `actionButtons` row, shared by the reader and its loading states. */
export const ENTRY_ACTION_BAR_CLASSES = "flex flex-wrap items-center gap-2 sm:gap-3";

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
  /**
   * Optional IANA time zone for formatting `date`. Omit to use the ambient zone
   * (the visitor's local zone). A prerendered mount passes a fixed zone on the
   * server so its SSR'd date doesn't render in the host's UTC; the `<time>`
   * re-renders in the visitor's zone after hydration (see LocalTime).
   */
  dateTimeZone?: string;
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
  /** Shows a "Back to list" button calling this */
  onBack?: () => void;
  // Slots for interactive client components
  /** Action buttons slot (star, read, narration, summarize buttons) */
  actionButtons?: ReactNode;
  /** Content inserted before the main article content (e.g., summary card, narration highlight styles) */
  beforeContent?: ReactNode;
  /** Content inserted after the article content (e.g., CTA buttons in demo) */
  afterContent?: ReactNode;
  /** Click handler for the rendered content (e.g. narrating from a paragraph) */
  onContentClick?: React.MouseEventHandler;
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
  dateTimeZone,
  datePrefix,
  contentHtml,
  fallbackContent,
  textSizeClass = DEFAULT_TEXT_SIZE_CLASS,
  textStyle,
  footerLinkDomain,
  unsubscribeUrl,
  isContentLoading,
  contentRef,
  onBack,
  actionButtons,
  beforeContent,
  afterContent,
  stickyControls,
  onContentClick,
  onTouchStart,
  onTouchEnd,
  onTouchCancel,
}: EntryArticleProps) {
  const displayFooterDomain = footerLinkDomain ?? (url ? getDomain(url) : "original site");

  return (
    <article
      className={ARTICLE_CLASSES}
      onTouchStart={onTouchStart}
      onTouchEnd={onTouchEnd}
      onTouchCancel={onTouchCancel}
    >
      {onBack && <BackButton onBack={onBack} />}

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
                className={`${TITLE_TEXT_CLASSES} hover:text-accent block transition-colors`}
              >
                {title}
              </a>
            ) : (
              <h1 className={TITLE_TEXT_CLASSES}>{title}</h1>
            )}
          </div>

          {/* Meta row: Source, Author, Date */}
          <div className={META_ROW_CLASSES}>
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
            <LocalTime
              date={date}
              format={(d) => `${datePrefix ? `${datePrefix} ` : ""}${formatDate(d, dateTimeZone)}`}
              className="basis-full sm:basis-auto"
            />
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
          contentRef={contentRef}
          onClick={onContentClick}
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
                className="ui-text-sm text-muted hover:text-body active:text-body inline-flex min-h-[44px] items-center gap-2 font-medium transition-colors"
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

function BackButton({ onBack }: { onBack: () => void }) {
  return (
    <button
      onClick={onBack}
      className="control-outline ui-text-sm text-muted hover:bg-surface-muted hover:text-body active:bg-surface-pressed mb-4 -ml-2 inline-flex min-h-[44px] items-center gap-2 rounded-md px-2 transition-colors sm:mb-6"
    >
      <ArrowLeftIcon className="h-4 w-4" />
      <span>Back to list</span>
    </button>
  );
}

/** A secondary button's frame with a placeholder label, for a button whose label isn't known yet. */
function ButtonSkeleton({ width }: { width: string }) {
  return (
    <span className={buttonClassName({ variant: "secondary", size: "sm" })}>
      <SkeletonText width={width} />
    </span>
  );
}

/**
 * The article layout with placeholder lines, for when nothing about the entry
 * is known yet. The back button is real: it doesn't need the entry.
 */
export function EntryArticleSkeleton({ onBack }: { onBack?: () => void }) {
  return (
    <div className={ARTICLE_CLASSES}>
      {onBack && <BackButton onBack={onBack} />}

      <header className="mb-6 sm:mb-8">
        <div className="mb-4 sm:mb-6">
          <div className={`${TITLE_TEXT_CLASSES} mb-2`}>
            <SkeletonText width="w-3/4" />
            <SkeletonText width="w-1/2" />
          </div>
          <div className={META_ROW_CLASSES}>
            <SkeletonText width="w-24" />
            {/* The date wraps to its own line on mobile, as in the real meta row */}
            <SkeletonText width="w-32" className="basis-full sm:basis-auto" />
          </div>
        </div>

        <div className={ENTRY_ACTION_BAR_CLASSES}>
          <ButtonSkeleton width="w-14" />
          <ButtonSkeleton width="w-16" />
          <ButtonSkeleton width="w-32" />
        </div>
      </header>

      <hr className="border-edge-strong mb-6 sm:mb-8" />

      <ContentSkeleton />
    </div>
  );
}

const CONTENT_SKELETON_PARAGRAPHS = [
  ["w-full", "w-full", "w-11/12", "w-2/3"],
  ["w-full", "w-11/12", "w-full", "w-1/3"],
  ["w-full", "w-4/5"],
];

/** Paragraphs of placeholder lines in the reader's text settings, so each line is a line of the article. */
function ContentSkeleton() {
  return (
    <div className={`${DEFAULT_TEXT_SIZE_CLASS} max-w-none`} style={ENTRY_TEXT_STYLE} role="status">
      <span className="sr-only">Loading content...</span>
      {CONTENT_SKELETON_PARAGRAPHS.map((lines, i) => (
        <p key={i}>
          {lines.map((width, j) => (
            <SkeletonText key={j} width={width} />
          ))}
        </p>
      ))}
    </div>
  );
}
