/**
 * EntryContentFallback Component
 *
 * Smart Suspense fallback for entry content that shows cached metadata from the
 * entry list while the full content loads. Falls back to skeleton if no cached data.
 *
 * Shows functional Star/Read buttons using cached data with optimistic updates.
 * Buttons that need full entry data (content toggle, full content, narration,
 * summarize) show as shimmers.
 */

"use client";

import { useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { findEntryInListCache } from "@/lib/cache/entry-cache";
import { useEntryMutations } from "@/lib/hooks/useEntryMutations";
import { ScrollContainer } from "@/components/layout/ScrollContainerContext";
import { Button } from "@/components/ui/button";
import {
  ArrowLeftIcon,
  StarIcon,
  StarFilledIcon,
  CircleIcon,
  CircleFilledIcon,
  ExternalLinkIcon,
} from "@/components/ui/icon-button";
import { EntryContentSkeleton, ContentSkeleton } from "./EntryContentStates";
import { getDomain } from "@/lib/format";
import { formatDate } from "./EntryContentHelpers";

interface EntryContentFallbackProps {
  entryId: string;
  onBack?: () => void;
}

/**
 * Shimmer placeholder for a button.
 */
function ButtonShimmer({ width = "w-24" }: { width?: string }) {
  return <div className={`h-10 ${width} bg-fill-muted animate-pulse rounded`} />;
}

/**
 * Fallback component for entry content Suspense boundary.
 * Shows cached entry header from list cache while full content loads.
 * Star and Read buttons are functional via optimistic updates.
 */
export function EntryContentFallback({ entryId, onBack }: EntryContentFallbackProps) {
  const queryClient = useQueryClient();

  // Try to find cached entry data from list queries
  const cachedEntry = findEntryInListCache(queryClient, entryId);

  // Entry mutations for star/read - these work optimistically even during loading
  const { markRead, star, unstar } = useEntryMutations();

  // Handle star toggle
  const handleStarToggle = useCallback(() => {
    if (!cachedEntry) return;
    if (cachedEntry.starred) {
      unstar(entryId);
    } else {
      star(entryId);
    }
  }, [cachedEntry, entryId, star, unstar]);

  // Handle read toggle
  const handleReadToggle = useCallback(() => {
    if (!cachedEntry) return;
    markRead([entryId], !cachedEntry.read);
  }, [cachedEntry, entryId, markRead]);

  // No cached data - show full skeleton
  if (!cachedEntry) {
    return (
      <ScrollContainer className="h-full overflow-y-auto">
        <EntryContentSkeleton />
      </ScrollContainer>
    );
  }

  // Show header with cached data + functional buttons + content skeleton
  const title = cachedEntry.title ?? "Untitled";
  const source = cachedEntry.feedTitle ?? "Unknown Feed";
  const date = cachedEntry.publishedAt ?? cachedEntry.fetchedAt;
  const url = cachedEntry.url;

  return (
    <ScrollContainer className="h-full overflow-y-auto">
      <article className="mx-auto max-w-3xl px-4 py-6 sm:py-8">
        {/* Back button */}
        {onBack && (
          <button
            onClick={onBack}
            className="ui-text-sm text-muted hover:bg-surface-muted mb-4 -ml-2 inline-flex min-h-[44px] items-center gap-2 rounded-md px-2 transition-colors hover:text-zinc-900 active:bg-zinc-200 sm:mb-6 dark:hover:text-zinc-100 dark:active:bg-zinc-700"
          >
            <ArrowLeftIcon className="h-4 w-4" />
            <span>Back to list</span>
          </button>
        )}

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
                    className="ui-text-xl sm:ui-text-2xl hover:text-accent text-strong block leading-tight font-bold underline-offset-2 transition-colors hover:underline md:text-3xl"
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
                {cachedEntry.author &&
                  cachedEntry.author.toLowerCase().trim() !== source.toLowerCase().trim() && (
                    <>
                      <span aria-hidden="true" className="text-faint hidden sm:inline">
                        |
                      </span>
                      <span className="hidden sm:inline">by {cachedEntry.author}</span>
                      <span className="sm:hidden">- {cachedEntry.author}</span>
                    </>
                  )}
                <span aria-hidden="true" className="text-faint hidden sm:inline">
                  |
                </span>
                <time dateTime={date.toISOString()} className="basis-full sm:basis-auto">
                  {formatDate(date)}
                </time>
              </div>
            </div>
          </div>

          {/* Action buttons - Star and Read are functional, others show shimmer */}
          <div className="flex flex-wrap items-center gap-2 sm:gap-3">
            {/* Star button - functional */}
            <Button
              variant={cachedEntry.starred ? "primary" : "secondary"}
              size="sm"
              onClick={handleStarToggle}
              aria-label={cachedEntry.starred ? "Remove from starred" : "Add to starred"}
            >
              {cachedEntry.starred ? (
                <StarFilledIcon className="h-5 w-5" />
              ) : (
                <StarIcon className="h-5 w-5" />
              )}
              <span className="ml-2">{cachedEntry.starred ? "Starred" : "Star"}</span>
            </Button>

            {/* Mark read/unread button - functional */}
            <Button
              variant="secondary"
              size="sm"
              onClick={handleReadToggle}
              aria-label={cachedEntry.read ? "Mark as unread" : "Mark as read"}
              title="Keyboard shortcut: m"
            >
              {cachedEntry.read ? (
                <CircleIcon className="h-4 w-4" />
              ) : (
                <CircleFilledIcon className="h-4 w-4" />
              )}
              <span className="ml-2">{cachedEntry.read ? "Read" : "Unread"}</span>
            </Button>

            {/* Shimmer for buttons that need full entry data */}
            {/* Full content button */}
            {url && <ButtonShimmer width="w-28" />}

            {/* Narration controls shimmer */}
            <ButtonShimmer width="w-20" />
          </div>
        </header>

        {/* Divider - always show */}
        <hr className="border-edge-strong mb-6 sm:mb-8" />

        {/* Content skeleton */}
        <ContentSkeleton />

        {/* Footer with original link - show if URL available */}
        {url && (
          <footer className="border-edge-strong mt-8 border-t pt-6 sm:mt-12 sm:pt-8">
            <a
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              className="ui-text-sm text-accent hover:text-accent-hover inline-flex min-h-[44px] items-center gap-2 font-medium transition-colors"
            >
              <ExternalLinkIcon className="h-4 w-4" />
              Read on {getDomain(url)}
            </a>
          </footer>
        )}
      </article>
    </ScrollContainer>
  );
}
