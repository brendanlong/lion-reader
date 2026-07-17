/**
 * EntryContentRenderer Component
 *
 * Memoized component for rendering the entry content HTML.
 * Extracted to prevent image flashing when read/starred status changes.
 * Only re-renders when the actual content changes.
 */

"use client";

import React, { useCallback, useRef } from "react";
import { useImagePrefetch } from "@/lib/hooks/useImagePrefetch";

interface EntryContentRendererProps {
  /** Sanitized HTML content to render */
  sanitizedContent: string | null;
  /** Fallback text content when HTML is not available */
  fallbackContent: string | null;
  /** Optional ref to the content container (for narration highlighting) */
  contentRef?: React.RefObject<HTMLDivElement | null>;
  /** CSS class for text size */
  textSizeClass: string;
  /** Inline style for text appearance */
  textStyle: React.CSSProperties;
}

/**
 * Renders the article content with proper styling.
 * Memoized to prevent unnecessary re-renders when parent state changes.
 *
 * Owns image prefetching (via {@link useImagePrefetch}) so every reader — the
 * real app and the demo, which both funnel through here — gets the same
 * flash-free image loading without each caller wiring it up separately.
 */
export const EntryContentRenderer = React.memo(function EntryContentRenderer({
  sanitizedContent,
  fallbackContent,
  contentRef,
  textSizeClass,
  textStyle,
}: EntryContentRendererProps) {
  // Own a stable ref for image prefetching, and forward the node to the
  // caller's ref (used by narration highlighting) when one is provided.
  const internalRef = useRef<HTMLDivElement | null>(null);
  const setContentRef = useCallback(
    (node: HTMLDivElement | null) => {
      internalRef.current = node;
      if (contentRef) contentRef.current = node;
    },
    [contentRef]
  );

  useImagePrefetch(internalRef, sanitizedContent);

  if (sanitizedContent) {
    return (
      <div
        ref={setContentRef}
        className={`${textSizeClass} reader-prose prose-headings:font-semibold prose-headings:text-zinc-900 dark:prose-headings:text-zinc-100 prose-a:text-accent prose-a:underline-offset-2 prose-img:rounded-lg prose-pre:overflow-x-auto prose-pre:whitespace-pre-wrap prose-pre:break-words prose-pre:bg-zinc-100 dark:prose-pre:bg-zinc-800 prose-code:text-zinc-800 dark:prose-code:text-zinc-200 prose-code:before:content-none prose-code:after:content-none prose-blockquote:border-l-zinc-300 dark:prose-blockquote:border-l-zinc-600 prose-blockquote:text-zinc-600 dark:prose-blockquote:text-zinc-400 max-w-none`}
        style={textStyle}
        dangerouslySetInnerHTML={{ __html: sanitizedContent }}
      />
    );
  }

  if (fallbackContent) {
    return (
      <p className="ui-text-base text-body leading-relaxed" style={textStyle}>
        {fallbackContent}
      </p>
    );
  }

  return <p className="text-muted italic">No content available.</p>;
});
