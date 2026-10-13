/**
 * EntryContentFallback Component
 *
 * Smart loading fallback for entry content that shows the entry's list-item
 * fields from the local store while the full content loads. Falls back to a
 * skeleton when the store doesn't hold the entry.
 *
 * Shows the reader's action bar as it will render: Star/Read/Collections work
 * now (optimistically), and the buttons that need the full entry (full
 * content, narration, summarize) are disabled with their idle labels.
 */

"use client";

import { useLocalEntry } from "@/lib/hooks/useLocalEntries";
import { useEntryMutations } from "@/lib/hooks/useEntryMutations";
import { ScrollContainer } from "@/components/layout/ScrollContainerContext";
import { StarButton, ReadToggleButton } from "@/components/entries/EntryStateButtons";
import { Button } from "@/components/ui/button";
import { SparklesIcon } from "@/components/ui/icons";
import { NarrationControlsSkeleton } from "@/components/narration";
import { useNarrationSettings } from "@/lib/narration/settings";
import { CollectionsButton } from "./CollectionsButton";
import { ENTRY_ACTION_BAR_CLASSES, EntryArticle, EntryArticleSkeleton } from "./EntryArticle";

interface EntryContentFallbackProps {
  entryId: string;
  onBack?: () => void;
  isSummarizationAvailable: boolean;
}

export function EntryContentFallback({
  entryId,
  onBack,
  isSummarizationAvailable,
}: EntryContentFallbackProps) {
  const cachedEntry = useLocalEntry(entryId);
  // Star/read work optimistically even while the full entry loads
  const { markRead, star, unstar } = useEntryMutations();
  const [narrationSettings] = useNarrationSettings();

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
            <div className={ENTRY_ACTION_BAR_CLASSES}>
              <StarButton
                starred={cachedEntry.starred}
                onToggle={() => (cachedEntry.starred ? unstar(entryId) : star(entryId))}
              />
              <ReadToggleButton
                read={cachedEntry.read}
                onToggle={() => markRead([entryId], !cachedEntry.read)}
              />
              <CollectionsButton entryId={entryId} />
              {cachedEntry.url && (
                <Button variant="secondary" size="sm" disabled>
                  Full Content
                </Button>
              )}
              {narrationSettings.enabled && <NarrationControlsSkeleton />}
              {isSummarizationAvailable && (
                <Button variant="secondary" size="sm" disabled>
                  <SparklesIcon className="h-4 w-4" />
                  <span className="ml-2">Summarize</span>
                </Button>
              )}
            </div>
          }
        />
      ) : (
        <EntryArticleSkeleton onBack={onBack} />
      )}
    </ScrollContainer>
  );
}
