/**
 * Admin Feeds Content
 *
 * Displays a paginated list of all feeds in the system with health monitoring.
 * Supports filtering by URL, user email, and broken status.
 * Uses infinite scroll for pagination and debounced search for filtering.
 */

"use client";

import { useState, useMemo, useCallback, useEffect, useRef } from "react";
import { useSearchParams } from "next/navigation";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatRelativeTime, formatFutureTime } from "@/lib/format";
import {
  SpinnerIcon,
  ExternalLinkIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  RssIcon,
} from "@/components/ui/icon-button";

// ============================================================================
// Constants
// ============================================================================

const DEBOUNCE_MS = 300;
const PAGE_SIZE = 50;

// ============================================================================
// Types
// ============================================================================

interface FeedItem {
  feedId: string;
  title: string | null;
  url: string | null;
  siteUrl: string | null;
  consecutiveFailures: number;
  lastError: string | null;
  lastFetchedAt: Date | null;
  lastEntriesUpdatedAt: Date | null;
  nextFetchAt: Date | null;
  websubActive: boolean;
  subscriberCount: number;
  lastFetchEntryCount: number | null;
  lastFetchSizeBytes: number | null;
  totalEntryCount: number;
  entriesPerWeek: number | null;
}

// ============================================================================
// Helpers
// ============================================================================

function formatBytes(bytes: number | null): string {
  if (bytes == null) return "--";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function truncateUrl(url: string, maxLength: number = 60): string {
  if (url.length <= maxLength) return url;
  return url.slice(0, maxLength) + "...";
}

function getFeedDisplayTitle(feed: FeedItem): string {
  if (feed.title) return feed.title;
  if (feed.url) {
    try {
      return new URL(feed.url).hostname;
    } catch {
      return feed.url;
    }
  }
  return "Unknown Feed";
}

// ============================================================================
// Status Badge
// ============================================================================

function FeedStatusBadge({ feed }: { feed: FeedItem }) {
  if (feed.consecutiveFailures > 0) {
    return (
      <span className="ui-text-xs inline-flex items-center rounded-full bg-red-100 px-2 py-0.5 font-medium text-red-700 dark:bg-red-900/30 dark:text-red-300">
        {feed.consecutiveFailures} failure{feed.consecutiveFailures === 1 ? "" : "s"}
      </span>
    );
  }
  return (
    <span className="ui-text-xs inline-flex items-center rounded-full bg-green-100 px-2 py-0.5 font-medium text-green-700 dark:bg-green-900/30 dark:text-green-300">
      Healthy
    </span>
  );
}

// ============================================================================
// WebSub Badge
// ============================================================================

function WebSubBadge() {
  return (
    <span className="ui-text-xs inline-flex items-center rounded-full bg-purple-100 px-2 py-0.5 font-medium text-purple-700 dark:bg-purple-900/30 dark:text-purple-300">
      WebSub
    </span>
  );
}

// ============================================================================
// Expandable Error
// ============================================================================

function ExpandableError({ error }: { error: string }) {
  const [expanded, setExpanded] = useState(false);
  const isLong = error.length > 120;

  return (
    <div className="mt-2 rounded-md bg-red-50 px-3 py-2 dark:bg-red-900/20">
      <p className="ui-text-sm text-red-700 dark:text-red-300">
        <span className="font-medium">Error: </span>
        {expanded || !isLong ? error : error.slice(0, 120) + "..."}
      </p>
      {isLong && (
        <button
          onClick={() => setExpanded(!expanded)}
          className="ui-text-xs mt-1 inline-flex items-center gap-0.5 text-red-600 hover:text-red-800 dark:text-red-400 dark:hover:text-red-200"
        >
          {expanded ? (
            <>
              Show less <ChevronUpIcon className="h-3 w-3" />
            </>
          ) : (
            <>
              Show more <ChevronDownIcon className="h-3 w-3" />
            </>
          )}
        </button>
      )}
    </div>
  );
}

// ============================================================================
// Feed Row
// ============================================================================

interface FeedRowProps {
  feed: FeedItem;
  onRetry: (feedId: string) => void;
  isRetrying: boolean;
}

function FeedRow({ feed, onRetry, isRetrying }: FeedRowProps) {
  const displayTitle = getFeedDisplayTitle(feed);

  return (
    <div className="border-b border-zinc-200 p-4 last:border-b-0 dark:border-zinc-800">
      {/* Title, Status, and URL */}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 flex-1">
          {/* Title and badges */}
          <div className="flex flex-wrap items-center gap-2">
            <p className="ui-text-sm font-medium text-zinc-900 dark:text-zinc-50">{displayTitle}</p>
            <FeedStatusBadge feed={feed} />
            {feed.websubActive && <WebSubBadge />}
          </div>

          {/* URL */}
          {feed.url && (
            <a
              href={feed.url}
              target="_blank"
              rel="noopener noreferrer"
              className="ui-text-xs mt-0.5 inline-flex items-center gap-1 text-zinc-500 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200"
            >
              <span className="truncate">{truncateUrl(feed.url)}</span>
              <ExternalLinkIcon className="h-3 w-3 shrink-0" />
            </a>
          )}
        </div>

        {/* Retry button for broken feeds */}
        {feed.consecutiveFailures > 0 && (
          <div className="shrink-0">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => onRetry(feed.feedId)}
              loading={isRetrying}
            >
              Retry
            </Button>
          </div>
        )}
      </div>

      {/* Error message */}
      {feed.lastError && <ExpandableError error={feed.lastError} />}

      {/* Stats grid */}
      <div className="ui-text-xs mt-3 grid grid-cols-2 gap-x-6 gap-y-1.5 text-zinc-500 sm:grid-cols-3 lg:grid-cols-4 dark:text-zinc-400">
        <StatItem
          label="Last fetched"
          value={feed.lastFetchedAt ? formatRelativeTime(new Date(feed.lastFetchedAt)) : "Never"}
        />
        <StatItem label="Next fetch" value={formatFutureTime(feed.nextFetchAt)} />
        <StatItem label="Subscribers" value={String(feed.subscriberCount)} />
        <StatItem label="Total entries" value={String(feed.totalEntryCount)} />
        <StatItem
          label="Entries/week"
          value={feed.entriesPerWeek != null ? feed.entriesPerWeek.toFixed(1) : "--"}
        />
        <StatItem
          label="Last fetch entries"
          value={feed.lastFetchEntryCount != null ? String(feed.lastFetchEntryCount) : "--"}
        />
        <StatItem label="Response size" value={formatBytes(feed.lastFetchSizeBytes)} />
      </div>
    </div>
  );
}

// ============================================================================
// Stat Item
// ============================================================================

function StatItem({ label, value }: { label: string; value: string }) {
  return (
    <span>
      <span className="font-medium text-zinc-700 dark:text-zinc-300">{label}:</span> {value}
    </span>
  );
}

// ============================================================================
// Empty State
// ============================================================================

function EmptyState({ hasFilters }: { hasFilters: boolean }) {
  return (
    <div className="p-8 text-center">
      <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-zinc-100 dark:bg-zinc-800">
        <RssIcon className="h-6 w-6 text-zinc-400 dark:text-zinc-500" />
      </div>
      <h3 className="ui-text-sm mt-4 font-medium text-zinc-900 dark:text-zinc-50">
        {hasFilters ? "No matching feeds" : "No feeds"}
      </h3>
      <p className="ui-text-sm mt-1 text-zinc-500 dark:text-zinc-400">
        {hasFilters ? "Try adjusting your filters." : "No feeds have been added to the system yet."}
      </p>
    </div>
  );
}

// ============================================================================
// Main Component
// ============================================================================

export default function AdminFeedsContent() {
  const searchParams = useSearchParams();
  const initialEmail = searchParams.get("userEmail") ?? "";

  const [urlInput, setUrlInput] = useState("");
  const [emailInput, setEmailInput] = useState(initialEmail);
  const [brokenOnly, setBrokenOnly] = useState(false);
  const [debouncedUrl, setDebouncedUrl] = useState("");
  const [debouncedEmail, setDebouncedEmail] = useState(initialEmail);
  const [retryingId, setRetryingId] = useState<string | null>(null);
  const loadMoreRef = useRef<HTMLDivElement>(null);

  const utils = trpc.useUtils();

  // Debounce URL filter
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedUrl(urlInput);
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [urlInput]);

  // Debounce email filter
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedEmail(emailInput);
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [emailInput]);

  // Query: list feeds with infinite scroll
  const feedsQuery = trpc.admin.listFeeds.useInfiniteQuery(
    {
      limit: PAGE_SIZE,
      urlFilter: debouncedUrl || undefined,
      userEmail: debouncedEmail || undefined,
      brokenOnly: brokenOnly || undefined,
    },
    {
      getNextPageParam: (lastPage) => lastPage.nextCursor,
    }
  );

  // Flatten all pages into a single list
  const feeds = useMemo(
    () => feedsQuery.data?.pages.flatMap((page) => page.items) ?? [],
    [feedsQuery.data?.pages]
  );

  // Mutation: retry feed fetch
  const retryMutation = trpc.admin.retryFeedFetch.useMutation({
    onSuccess: () => {
      setRetryingId(null);
      utils.admin.listFeeds.invalidate();
      toast.success("Feed retry scheduled");
    },
    onError: (error) => {
      setRetryingId(null);
      toast.error(error.message || "Failed to retry feed fetch");
    },
  });

  const handleRetry = useCallback(
    (feedId: string) => {
      setRetryingId(feedId);
      retryMutation.mutate({ feedId });
    },
    [retryMutation]
  );

  // Intersection Observer for infinite scroll
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = feedsQuery;
  const handleObserver = useCallback(
    (entries: IntersectionObserverEntry[]) => {
      const target = entries[0];
      if (target.isIntersecting && hasNextPage && !isFetchingNextPage) {
        fetchNextPage();
      }
    },
    [fetchNextPage, hasNextPage, isFetchingNextPage]
  );

  useEffect(() => {
    const observer = new IntersectionObserver(handleObserver, {
      rootMargin: "100px",
      threshold: 0,
    });

    const currentRef = loadMoreRef.current;
    if (currentRef) {
      observer.observe(currentRef);
    }

    return () => {
      if (currentRef) {
        observer.unobserve(currentRef);
      }
    };
  }, [handleObserver]);

  const hasFilters = debouncedUrl.length > 0 || debouncedEmail.length > 0 || brokenOnly;

  return (
    <div>
      {/* Header */}
      <div className="mb-6">
        <h2 className="ui-text-lg font-semibold text-zinc-900 dark:text-zinc-50">Feed Health</h2>
      </div>

      {/* Filter Controls */}
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-end">
        <div className="flex-1">
          <Input
            id="feed-url-filter"
            placeholder="Filter by URL or domain..."
            value={urlInput}
            onChange={(e) => setUrlInput(e.target.value)}
          />
        </div>
        <div className="flex-1">
          <Input
            id="feed-email-filter"
            placeholder="Filter by subscriber email..."
            value={emailInput}
            onChange={(e) => setEmailInput(e.target.value)}
          />
        </div>
        <div className="shrink-0">
          <Button
            variant={brokenOnly ? "primary" : "secondary"}
            size="sm"
            onClick={() => setBrokenOnly(!brokenOnly)}
          >
            Broken only
          </Button>
        </div>
      </div>

      {/* Feeds List */}
      {feedsQuery.isLoading ? (
        <div className="flex items-center justify-center p-8">
          <SpinnerIcon className="h-6 w-6 text-zinc-400" />
        </div>
      ) : feedsQuery.isError ? (
        <div className="p-8 text-center">
          <p className="ui-text-sm text-red-600 dark:text-red-400">
            Failed to load feeds. Please try again.
          </p>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => feedsQuery.refetch()}
            className="mt-2"
          >
            Retry
          </Button>
        </div>
      ) : feeds.length === 0 ? (
        <EmptyState hasFilters={hasFilters} />
      ) : (
        <div className="rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
          {feeds.map((feed) => (
            <FeedRow
              key={feed.feedId}
              feed={feed}
              onRetry={handleRetry}
              isRetrying={retryingId === feed.feedId}
            />
          ))}

          {/* Load more trigger element */}
          <div ref={loadMoreRef} className="h-1" />

          {/* Loading indicator */}
          {feedsQuery.isFetchingNextPage && (
            <div className="flex items-center justify-center p-4">
              <SpinnerIcon className="mr-2 h-4 w-4 text-zinc-400" />
              <span className="ui-text-sm text-zinc-500 dark:text-zinc-400">Loading more...</span>
            </div>
          )}

          {/* End of list */}
          {!feedsQuery.hasNextPage && feeds.length > 0 && (
            <p className="ui-text-xs p-3 text-center text-zinc-400 dark:text-zinc-500">
              No more feeds
            </p>
          )}
        </div>
      )}
    </div>
  );
}
