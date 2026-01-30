/**
 * EntryContent Component
 *
 * Displays the full content of a single entry.
 * Fetches entry data and delegates rendering to the shared EntryContentBody.
 */

"use client";

import { useEffect, useRef, useMemo, useCallback, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { trpc } from "@/lib/trpc/client";
import { toast } from "sonner";
import { useEntryMutations, useShowOriginalPreference } from "@/lib/hooks";
import { ScrollContainer } from "@/components/layout/ScrollContainerContext";
import { findEntryInListCache, listItemToPlaceholderEntry } from "@/lib/cache/entry-cache";
import {
  EntryContentBody,
  EntryContentSkeleton,
  EntryContentError,
  getDomain,
} from "./EntryContentBody";

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
 * EntryContent component.
 *
 * Fetches and displays the full content of an entry.
 * Marks the entry as read on mount.
 */
export function EntryContent({
  entryId,
  onBack,
  onSwipeNext,
  onSwipePrevious,
  nextEntryId,
  previousEntryId,
}: EntryContentProps) {
  const hasAutoMarkedRead = useRef(false);
  const queryClient = useQueryClient();

  // Fetch the entry with placeholderData from list cache for progressive rendering
  // This shows the header immediately while full content loads
  const { data, isLoading, isPlaceholderData, isError, error, refetch } = trpc.entries.get.useQuery(
    { id: entryId },
    {
      placeholderData: () => {
        const listItem = findEntryInListCache(queryClient, entryId);
        if (listItem) {
          return listItemToPlaceholderEntry(listItem);
        }
        return undefined;
      },
    }
  );

  // Use entry data directly (no delta merging)
  const entry = data?.entry ?? null;

  // Show content skeleton while using placeholder data (header visible, content loading)
  const isContentLoading = isPlaceholderData;

  // Show original preference is stored per-feed in localStorage
  const [showOriginal, setShowOriginal] = useShowOriginalPreference(entry?.feedId);

  // Prefetch next and previous entries with active observers to keep them in cache
  // These queries run in parallel and don't block the main entry fetch
  // We don't use their loading states, so they're invisible to the UI
  trpc.entries.get.useQuery({ id: nextEntryId! }, { enabled: !!nextEntryId });
  trpc.entries.get.useQuery({ id: previousEntryId! }, { enabled: !!previousEntryId });

  // Get subscriptions to look up tags and fetchFullContent setting for the entry's subscription
  const subscriptionsQuery = trpc.subscriptions.list.useQuery();
  const subscription = useMemo(() => {
    if (!entry?.subscriptionId || !subscriptionsQuery.data) return undefined;
    return subscriptionsQuery.data.items.find((sub) => sub.id === entry.subscriptionId);
  }, [entry, subscriptionsQuery.data]);

  // Get fetchFullContent setting from subscription
  const fetchFullContent = subscription?.fetchFullContent ?? false;

  // Entry mutations for marking read, starring, scoring, etc.
  const { markRead, star, unstar, setScore } = useEntryMutations();

  // Mutation to update subscription's fetchFullContent setting
  const utils = trpc.useUtils();
  const updateSubscriptionMutation = trpc.subscriptions.update.useMutation({
    onSuccess: () => {
      // Invalidate subscriptions list to reflect the new setting
      utils.subscriptions.list.invalidate();
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
      if (result.success) {
        // Invalidate entry query to get the new content
        utils.entries.get.invalidate({ id: entryId });
      } else if (result.error) {
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

  // Mark entry as read once when component mounts and entry data loads
  // The ref prevents re-marking if user later toggles read status
  // Component remounts on entry change (via key={openEntryId}), resetting the ref
  useEffect(() => {
    if (hasAutoMarkedRead.current || !entry) return;
    hasAutoMarkedRead.current = true;
    if (!entry.read) {
      markRead([entryId], true);
    }
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

  // Handle score change
  const handleSetScore = useCallback(
    (newScore: number | null) => {
      setScore(entryId, newScore);
    },
    [entryId, setScore]
  );

  // Determine content based on loading/error/success state
  // Progressive rendering: show header immediately if we have entry data (even if seeded from list)
  let content: React.ReactNode;
  if (isLoading && !entry) {
    // No cached data at all - show full skeleton
    content = <EntryContentSkeleton />;
  } else if (isError && !entry) {
    // Error with no cached data to show
    content = (
      <EntryContentError
        message={error?.message ?? "Failed to load entry"}
        onRetry={() => refetch()}
      />
    );
  } else if (!entry) {
    content = <EntryContentError message="Entry not found" onRetry={() => refetch()} />;
  } else {
    // Have entry data (full or seeded from list) - render progressively
    content = (
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
        // Progressive loading - show content skeleton while fetching full data
        isContentLoading={isContentLoading}
        // Score props
        score={entry.score ?? null}
        implicitScore={entry.implicitScore ?? 0}
        onSetScore={handleSetScore}
      />
    );
  }

  // Wrap in scroll container - each entry gets its own container that starts at scroll 0
  // ScrollContainer provides context so useImagePrefetch can observe this container
  return <ScrollContainer className="h-full overflow-y-auto">{content}</ScrollContainer>;
}
