/**
 * EntryContentFallback Component
 *
 * Smart Suspense fallback for entry content that shows cached metadata from the
 * entry list while the full content loads. Falls back to skeleton if no cached data.
 */

"use client";

import { useQueryClient } from "@tanstack/react-query";
import { findEntryInListCache } from "@/lib/cache/entry-cache";
import { ScrollContainer } from "@/components/layout/ScrollContainerContext";
import { ArrowLeftIcon } from "@/components/ui";
import { EntryContentSkeleton, ContentSkeleton } from "./EntryContentStates";
import { formatDate } from "./EntryContentHelpers";

interface EntryContentFallbackProps {
  entryId: string;
  onBack?: () => void;
}

/**
 * Fallback component for entry content Suspense boundary.
 * Shows cached entry header from list cache while full content loads.
 */
export function EntryContentFallback({ entryId, onBack }: EntryContentFallbackProps) {
  const queryClient = useQueryClient();

  // Try to find cached entry data from list queries
  const cachedEntry = findEntryInListCache(queryClient, entryId);

  // No cached data - show full skeleton
  if (!cachedEntry) {
    return (
      <ScrollContainer className="h-full overflow-y-auto">
        <EntryContentSkeleton />
      </ScrollContainer>
    );
  }

  // Show header with cached data + content skeleton
  const title = cachedEntry.title ?? "Untitled";
  const source = cachedEntry.feedTitle ?? "Unknown Feed";
  const date = cachedEntry.publishedAt ?? cachedEntry.fetchedAt;

  return (
    <ScrollContainer className="h-full overflow-y-auto">
      <article className="mx-auto max-w-3xl px-4 py-6 sm:py-8">
        {/* Back button */}
        {onBack && (
          <button
            onClick={onBack}
            className="mb-6 flex items-center gap-1 text-zinc-500 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200"
          >
            <ArrowLeftIcon className="h-4 w-4" />
            <span className="ui-text-sm">Back</span>
          </button>
        )}

        {/* Header */}
        <header className="mb-6">
          <h1 className="ui-text-xl sm:ui-text-2xl mb-2 font-bold text-zinc-900 dark:text-zinc-50">
            {title}
          </h1>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-zinc-500 dark:text-zinc-400">
            <span className="ui-text-sm font-medium">{source}</span>
            {cachedEntry.author && (
              <>
                <span className="text-zinc-300 dark:text-zinc-600">•</span>
                <span className="ui-text-sm">{cachedEntry.author}</span>
              </>
            )}
            <span className="text-zinc-300 dark:text-zinc-600">•</span>
            <time className="ui-text-sm">{formatDate(date)}</time>
          </div>
        </header>

        {/* Action buttons placeholder */}
        <div className="mb-8 flex animate-pulse gap-3">
          <div className="h-10 w-24 rounded bg-zinc-200 dark:bg-zinc-700" />
          <div className="h-10 w-32 rounded bg-zinc-200 dark:bg-zinc-700" />
        </div>

        {/* Content skeleton */}
        <ContentSkeleton />
      </article>
    </ScrollContainer>
  );
}
