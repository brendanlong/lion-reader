/**
 * EntryContent Component
 *
 * Displays the full content of a single entry.
 * Fetches entry data and delegates rendering to the shared EntryContentBody.
 *
 * Uses a non-suspending useQuery with an inline fallback (cached entry metadata
 * from the list while full content loads) rather than Suspense, to avoid React's
 * 300ms FALLBACK_THROTTLE_MS on warm-cache opens. See "Suspense vs. inline
 * loading" in src/CLAUDE.md.
 */

"use client";

import { useEffect, useRef, useCallback, useState } from "react";
import { trpc } from "@/lib/trpc/client";
import { toast } from "sonner";
import { useEntryMutations } from "@/lib/hooks/useEntryMutations";
import { useShowOriginalPreference } from "@/lib/hooks/useShowOriginalPreference";
import { useIsHydrated } from "@/lib/hooks/useIsHydrated";
import { ScrollContainer } from "@/components/layout/ScrollContainerContext";
import { ErrorBoundary } from "@/components/ui/ErrorBoundary";
import { getDomain } from "@/lib/format";
import { EntryContentBody } from "./EntryContentBody";
import { EntryContentFallback } from "./EntryContentFallback";
import { EntryContentSkeleton } from "./EntryContentStates";

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
   * Optional callback when swiping to next entry.
   */
  onSwipeNext?: () => void;

  /**
   * Optional callback when swiping to previous entry.
   */
  onSwipePrevious?: () => void;

  /**
   * Optional ID of the next entry to prefetch.
   */
  nextEntryId?: string;

  /**
   * Optional ID of the previous entry to prefetch.
   */
  previousEntryId?: string;
}

/**
 * Inner component that fetches and displays entry content.
 * Uses a non-suspending useQuery and renders its own inline loading fallback;
 * there is no parent Suspense boundary (only an ErrorBoundary).
 */
function EntryContentInner({
  entryId,
  onBack,
  onSwipeNext,
  onSwipePrevious,
  nextEntryId,
  previousEntryId,
}: EntryContentProps) {
  const utils = trpc.useUtils();

  // False during SSR + first client render. The cache-reading fallback below
  // would mismatch (empty server cache vs. hydrated client cache), so until
  // hydration we render a deterministic skeleton. See useIsHydrated.
  const isHydrated = useIsHydrated();

  // Track whether we've sent the auto-mark-read mutation
  const hasSentMarkReadMutation = useRef(false);

  // Fetch the entry with a non-suspending query so the loading state is
  // rendered inline (see the `!entry` branch below) instead of via a Suspense
  // fallback. A committed Suspense fallback is pinned on screen for React's
  // FALLBACK_THROTTLE_MS (300ms) even when the data is already cached, which
  // made opening an entry feel laggy on a warm cache. `throwOnError` preserves
  // the surrounding ErrorBoundary behavior that useSuspenseQuery gave us.
  // See "Suspense vs. inline loading" in src/CLAUDE.md.
  const { data } = trpc.entries.get.useQuery({ id: entryId }, { throwOnError: true });

  // Undefined while the query is loading; the `!entry` branch renders the
  // fallback. Every hook below already tolerates an absent entry.
  const entry = data?.entry;

  // Show original preference is stored per-feed in localStorage
  const [showOriginal, setShowOriginal] = useShowOriginalPreference(entry?.feedId);

  // Prefetch next and previous entries - use regular useQuery since these are optional
  // and should not suspend the UI
  trpc.entries.get.useQuery({ id: nextEntryId! }, { enabled: !!nextEntryId });
  trpc.entries.get.useQuery({ id: previousEntryId! }, { enabled: !!previousEntryId });

  // Get fetchFullContent setting directly from entry (included in entries.get response)
  // This avoids a separate subscriptions.get query
  const fetchFullContent = entry?.fetchFullContent ?? false;

  // Entry mutations for marking read, starring, etc.
  const { markRead, star, unstar } = useEntryMutations();

  // Mutation to update subscription's fetchFullContent setting
  const updateSubscriptionMutation = trpc.subscriptions.update.useMutation({
    onSuccess: (_data, variables) => {
      // Invalidate subscriptions list to reflect the new setting
      utils.subscriptions.list.invalidate();
      // Update entry cache with new fetchFullContent value if it was changed
      if (variables.fetchFullContent !== undefined) {
        utils.entries.get.setData({ id: entryId }, (oldData) => {
          if (!oldData) return oldData;
          return {
            entry: { ...oldData.entry, fetchFullContent: variables.fetchFullContent! },
          };
        });
      }
    },
    onError: (error) => {
      toast.error("Failed to update subscription setting", {
        description: error.message,
      });
    },
  });

  // Mutation to fetch full content for the entry
  const fetchFullContentMutation = trpc.entries.fetchFullContent.useMutation({
    onSuccess: (result) => {
      // Update the entry cache with the returned data
      // The mutation returns the updated entry with fullContentFetchedAt/fullContentError
      if (result.entry) {
        utils.entries.get.setData({ id: entryId }, (oldData) => {
          if (!oldData) return oldData;
          return { entry: { ...oldData.entry, ...result.entry } };
        });
      } else {
        // Fallback: invalidate to refetch from server
        utils.entries.get.invalidate({ id: entryId });
      }

      if (!result.success && result.error) {
        toast.error("Failed to fetch full content", {
          description: result.error,
        });
      }
    },
    onError: (error) => {
      toast.error("Failed to fetch full content", {
        description: error.message,
      });
    },
  });

  // Handle toggling fetchFullContent setting
  const handleToggleFetchFullContent = useCallback(() => {
    if (!entry?.subscriptionId) return;

    const newValue = !fetchFullContent;
    updateSubscriptionMutation.mutate({
      id: entry.subscriptionId,
      fetchFullContent: newValue,
    });

    // If enabling full content and it hasn't been fetched successfully, trigger fetch
    // This includes retrying after a previous error
    const needsFetch = !entry.fullContentFetchedAt || entry.fullContentError;
    if (newValue && needsFetch) {
      fetchFullContentMutation.mutate({ id: entryId });
    }
  }, [entry, fetchFullContent, entryId, updateSubscriptionMutation, fetchFullContentMutation]);

  // Determine if full content is currently being shown
  // This mirrors the logic in EntryContentBody for content selection
  const hasFullContent = Boolean(
    (entry?.fullContentCleaned || entry?.fullContentOriginal) &&
    entry?.fullContentFetchedAt &&
    !entry?.fullContentError
  );
  const isShowingFullContent = fetchFullContent && hasFullContent;

  // Summarization state — track separate summaries for feed vs full content
  type SummaryData = {
    text: string;
    modelId: string;
    generatedAt: Date | null;
    settingsChanged: boolean;
  };
  const [feedSummary, setFeedSummary] = useState<SummaryData | null>(null);
  const [fullContentSummary, setFullContentSummary] = useState<SummaryData | null>(null);
  const [showSummary, setShowSummary] = useState(false);
  const [summaryError, setSummaryError] = useState<string | null>(null);

  // The active summary is whichever matches the currently displayed content version
  const summary = isShowingFullContent ? fullContentSummary : feedSummary;

  // Check if summarization is available
  const summarizationAvailableQuery = trpc.summarization.isAvailable.useQuery();
  const isSummarizationAvailable = summarizationAvailableQuery.data?.available ?? false;

  // Track which content version the current mutation is for
  const mutationIsForFullContent = useRef(false);

  // Summarization mutation
  const summarizationMutation = trpc.summarization.generate.useMutation({
    onSuccess: (result) => {
      const summaryData: SummaryData = {
        text: result.summary,
        modelId: result.modelId,
        generatedAt: result.generatedAt,
        settingsChanged: result.settingsChanged,
      };
      if (mutationIsForFullContent.current) {
        setFullContentSummary(summaryData);
      } else {
        setFeedSummary(summaryData);
      }
      setSummaryError(null);
      setShowSummary(true);
    },
    onError: (error) => {
      setSummaryError(error.message);
      setShowSummary(true);
    },
  });

  // Handle summarize button click
  const handleSummarize = useCallback(() => {
    if (summary) {
      // Toggle visibility if we already have a summary for current view
      setShowSummary(!showSummary);
    } else {
      // Generate new summary for the content version being displayed
      setSummaryError(null);
      mutationIsForFullContent.current = isShowingFullContent;
      summarizationMutation.mutate({
        entryId,
        useFullContent: isShowingFullContent,
      });
    }
  }, [summary, showSummary, summarizationMutation, entryId, isShowingFullContent]);

  // Handle summary close
  const handleSummaryClose = useCallback(() => {
    setShowSummary(false);
  }, []);

  // Handle summary regenerate
  const handleSummaryRegenerate = useCallback(() => {
    setSummaryError(null);
    mutationIsForFullContent.current = isShowingFullContent;
    summarizationMutation.mutate({
      entryId,
      useFullContent: isShowingFullContent,
      regenerate: true,
    });
  }, [summarizationMutation, entryId, isShowingFullContent]);

  // Auto-fetch full content when entry loads and setting is enabled
  const hasAutoFetchedFullContent = useRef(false);
  useEffect(() => {
    if (hasAutoFetchedFullContent.current || !entry) return;
    if (!fetchFullContent) return;
    // Skip if already fetched successfully (has timestamp but no error)
    if (entry.fullContentFetchedAt && !entry.fullContentError) return;
    if (fetchFullContentMutation.isPending) return; // Already fetching

    hasAutoFetchedFullContent.current = true;
    fetchFullContentMutation.mutate({ id: entryId });
  }, [entry, fetchFullContent, entryId, fetchFullContentMutation]);

  // Auto-mark-read: Fire mutation once on mount to mark the entry as read
  // and update readChangedAt so it appears in Recently Read.
  // The mutation runs in parallel with the get query. Both use updatedAt timestamps
  // to determine which state wins, so race conditions are handled correctly.
  useEffect(() => {
    // Only fire once per entry - check this first
    if (hasSentMarkReadMutation.current) return;
    // Need entry data to check read status
    if (!entry) return;

    // Mark that we've done the initial check - this prevents re-triggering
    // if the user manually marks the entry unread later
    hasSentMarkReadMutation.current = true;

    // Always mark read, even if already read, so readChangedAt is updated
    // and the entry appears in the Recently Read list
    markRead([entryId], true);
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

  // Handle read toggle from entry view
  // Marking unread sets implicit score signal (+1), marking read does NOT
  // (only marking read from the entry list sets implicit -1)
  const handleReadToggle = () => {
    if (!entry) return;
    markRead([entryId], !entry.read);
  };

  // Deterministic skeleton on the server + first client render so hydration
  // matches (the smart fallback below reads the cache, which differs between
  // server and client at that point).
  if (!isHydrated) {
    return (
      <ScrollContainer className="h-full overflow-y-auto">
        <EntryContentSkeleton />
      </ScrollContainer>
    );
  }

  // Loading state (post-hydration, client-only): render the smart fallback
  // inline (cached header + skeleton) instead of suspending. `entry` is
  // undefined only while the query is loading; once it resolves (or hits the
  // warm cache) we render content immediately, with no Suspense throttle.
  if (!entry) {
    return <EntryContentFallback entryId={entryId} onBack={onBack} />;
  }

  // Wrap in scroll container - each entry gets its own container that starts at scroll 0
  // ScrollContainer provides context so useImagePrefetch can observe this container
  return (
    <ScrollContainer className="h-full overflow-y-auto">
      <EntryContentBody
        articleId={entryId}
        title={entry.title ?? "Untitled"}
        source={
          (entry.type === "saved" ? entry.siteName : null) ?? entry.feedTitle ?? "Unknown Feed"
        }
        author={entry.author}
        url={entry.url}
        date={entry.publishedAt ?? entry.fetchedAt}
        contentOriginal={entry.contentOriginal}
        contentCleaned={entry.contentCleaned}
        fallbackContent={entry.summary}
        read={entry.read}
        starred={entry.starred}
        onBack={onBack}
        onToggleRead={handleReadToggle}
        onToggleStar={handleStarToggle}
        showOriginal={showOriginal}
        setShowOriginal={setShowOriginal}
        footerLinkDomain={entry.feedUrl ? getDomain(entry.feedUrl) : undefined}
        unsubscribeUrl={entry.unsubscribeUrl}
        onSwipeNext={onSwipeNext}
        onSwipePrevious={onSwipePrevious}
        // Full content props - only available if entry has a subscription
        fullContentOriginal={entry.fullContentOriginal}
        fullContentCleaned={entry.fullContentCleaned}
        fullContentFetchedAt={entry.fullContentFetchedAt}
        fullContentError={entry.fullContentError}
        fetchFullContent={fetchFullContent}
        isFullContentFetching={fetchFullContentMutation.isPending}
        onToggleFetchFullContent={entry.subscriptionId ? handleToggleFetchFullContent : undefined}
        // Summarization props
        isSummarizationAvailable={isSummarizationAvailable}
        summary={summary}
        showSummary={showSummary}
        summaryError={summaryError}
        isSummarizing={summarizationMutation.isPending}
        onSummarize={handleSummarize}
        onSummaryClose={handleSummaryClose}
        onSummaryRegenerate={handleSummaryRegenerate}
      />
    </ScrollContainer>
  );
}

/**
 * EntryContent component.
 *
 * Wrapper that provides error handling. EntryContentInner uses a non-suspending
 * query and renders its own inline loading fallback (cached entry metadata from
 * the list while full content loads), deliberately avoiding a Suspense boundary
 * so React's 300ms fallback throttle doesn't lag warm-cache opens. See
 * "Suspense vs. inline loading" in src/CLAUDE.md.
 */
export function EntryContent(props: EntryContentProps) {
  return (
    <ErrorBoundary message="Failed to load entry">
      <EntryContentInner {...props} />
    </ErrorBoundary>
  );
}
