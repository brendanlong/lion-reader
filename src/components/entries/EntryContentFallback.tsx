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

import { useQueryClient } from "@tanstack/react-query";
import { findEntryInListCache } from "@/lib/cache/entry-cache";
import { useEntryMutations } from "@/lib/hooks/useEntryMutations";
import { ScrollContainer } from "@/components/layout/ScrollContainerContext";
import { StarButton, ReadToggleButton } from "@/components/entries/EntryStateButtons";
import { EntryArticle } from "./EntryArticle";
import { EntryContentSkeleton } from "./EntryContentStates";

interface EntryContentFallbackProps {
  entryId: string;
  onBack?: () => void;
}

/**
 * Shimmer placeholder for a button.
 */
function ButtonShimmer({ width }: { width: string }) {
  return <div className={`h-10 ${width} bg-fill-muted animate-pulse rounded`} />;
}

export function EntryContentFallback({ entryId, onBack }: EntryContentFallbackProps) {
  const queryClient = useQueryClient();
  const cachedEntry = findEntryInListCache(queryClient, entryId);
  // Star/read work optimistically even while the full entry loads
  const { markRead, star, unstar } = useEntryMutations();

  return (
    <ScrollContainer className="h-full overflow-y-auto">
      {cachedEntry ? (
        <EntryArticle
          title={cachedEntry.title ?? "Untitled"}
          url={cachedEntry.url}
          source={cachedEntry.feedTitle ?? "Unknown Feed"}
          author={cachedEntry.author}
          date={cachedEntry.publishedAt ?? cachedEntry.fetchedAt}
          contentHtml={null}
          fallbackContent={null}
          isContentLoading
          onBack={onBack}
          actionButtons={
            <div className="flex flex-wrap items-center gap-2 sm:gap-3">
              <StarButton
                starred={cachedEntry.starred}
                onToggle={() => (cachedEntry.starred ? unstar(entryId) : star(entryId))}
              />
              <ReadToggleButton
                read={cachedEntry.read}
                onToggle={() => markRead([entryId], !cachedEntry.read)}
              />
              {/* Shimmers for the full content toggle and narration controls */}
              {cachedEntry.url && <ButtonShimmer width="w-28" />}
              <ButtonShimmer width="w-20" />
            </div>
          }
        />
      ) : (
        <EntryContentSkeleton />
      )}
    </ScrollContainer>
  );
}
