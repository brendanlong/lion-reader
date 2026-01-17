/**
 * EntryContent Component
 *
 * Displays the full content of a single entry.
 * Fetches entry data and delegates rendering to the shared EntryContentBody.
 */

"use client";

import { useEffect, useRef, useMemo, useCallback, useState } from "react";
import { trpc } from "@/lib/trpc/client";
import { toast } from "sonner";
import { useEntryMutations, useShowOriginalPreference } from "@/lib/hooks";
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

  // Fetch the entry
  const { data, isLoading, isError, error, refetch } = trpc.entries.get.useQuery({ id: entryId });

  // Use entry data directly (no delta merging)
  const entry = data?.entry ?? null;

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

  // Entry mutations for marking read, starring, etc.
  const { markRead, star, unstar } = useEntryMutations();

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

    // If enabling full content and it hasn't been fetched yet, trigger fetch
    if (newValue && !entry.fullContentFetchedAt) {
      fetchFullContentMutation.mutate({ id: entryId });
    }
  }, [entry, fetchFullContent, entryId, updateSubscriptionMutation, fetchFullContentMutation]);

  // Summarization state and mutation
  const [summary, setSummary] = useState<{
    text: string;
    modelId: string;
    generatedAt: Date | null;
    settingsChanged: boolean;
  } | null>(null);
  const [showSummary, setShowSummary] = useState(false);
  const [summaryError, setSummaryError] = useState<string | null>(null);

  // Check if summarization is available
  const summarizationAvailableQuery = trpc.summarization.isAvailable.useQuery();
  const isSummarizationAvailable = summarizationAvailableQuery.data?.available ?? false;

  // Summarization mutation
  const summarizationMutation = trpc.summarization.generate.useMutation({
    onSuccess: (result) => {
      setSummary({
        text: result.summary,
        modelId: result.modelId,
        generatedAt: result.generatedAt,
        settingsChanged: result.settingsChanged,
      });
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
      // Toggle visibility if we already have a summary
      setShowSummary(!showSummary);
    } else {
      // Generate new summary
      setSummaryError(null);
      summarizationMutation.mutate({ entryId });
    }
  }, [summary, showSummary, summarizationMutation, entryId]);

  // Handle summary close
  const handleSummaryClose = useCallback(() => {
    setShowSummary(false);
  }, []);

  // Handle summary regenerate
  const handleSummaryRegenerate = useCallback(() => {
    setSummaryError(null);
    summarizationMutation.mutate({ entryId });
  }, [summarizationMutation, entryId]);

  // Auto-fetch full content when entry loads and setting is enabled
  const hasAutoFetchedFullContent = useRef(false);
  useEffect(() => {
    if (hasAutoFetchedFullContent.current || !entry) return;
    if (!fetchFullContent) return;
    if (entry.fullContentFetchedAt) return; // Already fetched
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
      markRead([entryId], true, entry.type);
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

  // Handle read toggle - use local mutation for consistent loading state
  const handleReadToggle = () => {
    if (!entry) return;
    markRead([entryId], !entry.read, entry.type);
  };

  // Determine content based on loading/error/success state
  let content: React.ReactNode;
  if (isLoading) {
    content = <EntryContentSkeleton />;
  } else if (isError) {
    content = (
      <EntryContentError
        message={error?.message ?? "Failed to load entry"}
        onRetry={() => refetch()}
      />
    );
  } else if (!entry) {
    content = <EntryContentError message="Entry not found" onRetry={() => refetch()} />;
  } else {
    content = (
      <EntryContentBody
        articleId={entryId}
        title={entry.title ?? "Untitled"}
        source={entry.feedTitle ?? "Unknown Feed"}
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
    );
  }

  // Wrap in scroll container - each entry gets its own container that starts at scroll 0
  return <div className="h-full overflow-y-auto">{content}</div>;
}
