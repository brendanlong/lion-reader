/**
 * EntryContentRenderer Component
 *
 * Memoized component for rendering the entry content HTML.
 * Extracted to prevent image flashing when read/starred status changes.
 * Only re-renders when the actual content changes.
 */

"use client";

import React from "react";

interface EntryContentRendererProps {
  /** Sanitized HTML content to render */
  sanitizedContent: string | null;
  /** Fallback text content when HTML is not available */
  fallbackContent: string | null;
  /** Ref to the content container (for highlighting) */
  contentRef: React.RefObject<HTMLDivElement | null>;
  /** CSS class for text size */
  textSizeClass: string;
  /** Inline style for text appearance */
  textStyle: React.CSSProperties;
}

/**
 * Renders the article content with proper styling.
 * Memoized to prevent unnecessary re-renders when parent state changes.
 */
export const EntryContentRenderer = React.memo(function EntryContentRenderer({
  sanitizedContent,
  fallbackContent,
  contentRef,
  textSizeClass,
  textStyle,
}: EntryContentRendererProps) {
  if (sanitizedContent) {
    return (
      <div
        ref={contentRef}
        className={`${textSizeClass} prose-headings:font-semibold prose-headings:text-zinc-900 dark:prose-headings:text-zinc-100 prose-a:text-accent prose-a:underline-offset-2 hover:prose-a:text-accent-hover prose-img:rounded-lg prose-img:shadow-md prose-pre:overflow-x-auto prose-pre:bg-zinc-100 dark:prose-pre:bg-zinc-800 prose-code:text-zinc-800 dark:prose-code:text-zinc-200 prose-blockquote:border-l-zinc-300 dark:prose-blockquote:border-l-zinc-600 prose-blockquote:text-zinc-600 dark:prose-blockquote:text-zinc-400 max-w-none`}
        style={textStyle}
        dangerouslySetInnerHTML={{ __html: sanitizedContent }}
      />
    );
  }

  if (fallbackContent) {
    return (
      <p
        className="ui-text-base leading-relaxed text-zinc-700 dark:text-zinc-300"
        style={textStyle}
      >
        {fallbackContent}
      </p>
    );
  }

  return <p className="text-zinc-500 italic dark:text-zinc-400">No content available.</p>;
});
