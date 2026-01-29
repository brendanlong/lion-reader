/**
 * Subscribe Page
 *
 * Allows users to subscribe to new feeds.
 * Provides URL input with feed preview before confirming subscription.
 * If the URL is not a direct feed, automatically discovers feeds on the page.
 * Also supports subscribing to LessWrong API feeds.
 */

"use client";

import { useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc/client";
import { Button, Input, Alert } from "@/components/ui";

// ============================================================================
// Types
// ============================================================================

interface DiscoveredFeed {
  url: string;
  type: "rss" | "atom" | "json" | "unknown";
  title?: string;
}

type FeedSource = "standard" | "lesswrong";
type LessWrongView = "frontpage" | "curated" | "all" | "userPosts" | "tagRelevance";
type Step = "input" | "discovery" | "preview";

// ============================================================================
// Constants
// ============================================================================

const LESSWRONG_VIEW_OPTIONS: { value: LessWrongView; label: string }[] = [
  { value: "frontpage", label: "Frontpage" },
  { value: "curated", label: "Curated" },
  { value: "all", label: "All Posts" },
  { value: "userPosts", label: "User Posts" },
  { value: "tagRelevance", label: "Tag Posts" },
];

// ============================================================================
// Component
// ============================================================================

export default function SubscribePage() {
  const router = useRouter();
  const [url, setUrl] = useState("");
  const [urlError, setUrlError] = useState<string | undefined>();
  const [step, setStep] = useState<Step>("input");
  const [discoveredFeeds, setDiscoveredFeeds] = useState<DiscoveredFeed[]>([]);
  const [selectedFeedUrl, setSelectedFeedUrl] = useState<string | null>(null);
  const [discoveryError, setDiscoveryError] = useState<string | null>(null);

  // LessWrong-specific state
  const [feedSource, setFeedSource] = useState<FeedSource>("standard");
  const [lwView, setLwView] = useState<LessWrongView>("frontpage");
  const [lwUserId, setLwUserId] = useState("");
  const [lwTagId, setLwTagId] = useState("");
  const [lwError, setLwError] = useState<string | null>(null);

  const utils = trpc.useUtils();

  // Preview query - only runs when we explicitly call refetch
  const previewQuery = trpc.feeds.preview.useQuery(
    { url: selectedFeedUrl || url },
    {
      enabled: false,
      retry: false,
    }
  );

  // LessWrong preview query
  const lwPreviewQuery = trpc.feeds.previewLessWrong.useQuery(
    {
      view: lwView,
      userId: lwView === "userPosts" ? lwUserId : undefined,
      tagId: lwView === "tagRelevance" ? lwTagId : undefined,
    },
    {
      enabled: false,
      retry: false,
    }
  );

  // Discovery query - only runs when we explicitly call refetch
  const discoverQuery = trpc.feeds.discover.useQuery(
    { url },
    {
      enabled: false,
      retry: false,
    }
  );

  // Subscribe mutation (standard feeds)
  const subscribeMutation = trpc.subscriptions.create.useMutation({
    onSuccess: (data) => {
      utils.subscriptions.list.setData(undefined, (oldData) => {
        if (!oldData) {
          return { items: [data] };
        }
        if (oldData.items.some((item) => item.id === data.id)) {
          return oldData;
        }
        const newItems = [...oldData.items, data];
        newItems.sort((a, b) => {
          const titleA = (a.title || a.originalTitle || "").toLowerCase();
          const titleB = (b.title || b.originalTitle || "").toLowerCase();
          return titleA.localeCompare(titleB);
        });
        return { ...oldData, items: newItems };
      });
      router.push("/all");
    },
    onError: () => {
      toast.error("Failed to subscribe to feed");
    },
  });

  // Subscribe mutation (LessWrong feeds)
  const lwSubscribeMutation = trpc.subscriptions.createLessWrong.useMutation({
    onSuccess: (data) => {
      utils.subscriptions.list.setData(undefined, (oldData) => {
        if (!oldData) {
          return { items: [data] };
        }
        if (oldData.items.some((item) => item.id === data.id)) {
          return oldData;
        }
        const newItems = [...oldData.items, data];
        newItems.sort((a, b) => {
          const titleA = (a.title || a.originalTitle || "").toLowerCase();
          const titleB = (b.title || b.originalTitle || "").toLowerCase();
          return titleA.localeCompare(titleB);
        });
        return { ...oldData, items: newItems };
      });
      router.push("/all");
    },
    onError: () => {
      toast.error("Failed to subscribe to LessWrong feed");
    },
  });

  const validateUrl = (value: string): boolean => {
    if (!value.trim()) {
      setUrlError("URL is required");
      return false;
    }

    try {
      const parsedUrl = new URL(value);
      if (!["http:", "https:"].includes(parsedUrl.protocol)) {
        setUrlError("URL must use http or https protocol");
        return false;
      }
    } catch {
      setUrlError("Please enter a valid URL");
      return false;
    }

    setUrlError(undefined);
    return true;
  };

  /**
   * Checks if an error indicates we should try discovery
   */
  const shouldTryDiscovery = useCallback((error: { message: string }): boolean => {
    const message = error.message.toLowerCase();
    return (
      message.includes("no feeds found") ||
      message.includes("failed to parse feed") ||
      message.includes("invalid feed format")
    );
  }, []);

  const handlePreview = async () => {
    if (!validateUrl(url)) {
      return;
    }

    // Reset state
    setSelectedFeedUrl(null);
    setDiscoveredFeeds([]);
    setDiscoveryError(null);

    // First, try to preview directly
    const result = await previewQuery.refetch();

    if (result.data) {
      // Direct preview succeeded
      setStep("preview");
      return;
    }

    // If preview failed, check if we should try discovery
    if (result.error && shouldTryDiscovery(result.error)) {
      // Try discovery
      const discoverResult = await discoverQuery.refetch();

      if (discoverResult.data && discoverResult.data.feeds.length > 0) {
        // Found feeds via discovery
        setDiscoveredFeeds(discoverResult.data.feeds);
        setStep("discovery");
        return;
      }

      // No feeds found anywhere
      setDiscoveryError(
        "We couldn't find any feeds at this URL. Please check the URL and try again, or enter a direct feed URL."
      );
    }
    // If preview failed for other reasons (network error, etc.), the error will be shown via previewQuery.error
  };

  const handleLwPreview = async () => {
    setLwError(null);

    // Validate required fields
    if (lwView === "userPosts" && !lwUserId.trim()) {
      setLwError("User ID is required for User Posts view");
      return;
    }
    if (lwView === "tagRelevance" && !lwTagId.trim()) {
      setLwError("Tag ID is required for Tag Posts view");
      return;
    }

    const result = await lwPreviewQuery.refetch();

    if (result.data) {
      setStep("preview");
    } else if (result.error) {
      setLwError(result.error.message);
    }
  };

  const handleSelectFeed = async (feedUrl: string) => {
    setSelectedFeedUrl(feedUrl);

    // Preview the selected feed
    const result = await previewQuery.refetch();

    if (result.data) {
      setStep("preview");
    }
    // If preview fails, error will be shown via previewQuery.error
  };

  const handleSubscribe = () => {
    if (feedSource === "lesswrong") {
      lwSubscribeMutation.mutate({
        view: lwView,
        userId: lwView === "userPosts" ? lwUserId : undefined,
        tagId: lwView === "tagRelevance" ? lwTagId : undefined,
      });
    } else {
      subscribeMutation.mutate({ url: previewQuery.data?.feed.url ?? selectedFeedUrl ?? url });
    }
  };

  const handleBack = () => {
    if (step === "preview" && discoveredFeeds.length > 0) {
      // Go back to discovery if we came from there
      setStep("discovery");
      setSelectedFeedUrl(null);
    } else {
      // Go back to input
      setStep("input");
      setSelectedFeedUrl(null);
      setDiscoveredFeeds([]);
      setDiscoveryError(null);
      setLwError(null);
    }
  };

  const formatDate = (date: Date | null) => {
    if (!date) return "Unknown";
    return new Intl.DateTimeFormat("en-US", {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(date);
  };

  const getFeedTypeLabel = (type: "rss" | "atom" | "json" | "unknown"): string => {
    switch (type) {
      case "rss":
        return "RSS";
      case "atom":
        return "Atom";
      case "json":
        return "JSON Feed";
      default:
        return "Feed";
    }
  };

  const isLoading =
    previewQuery.isFetching || discoverQuery.isFetching || lwPreviewQuery.isFetching;

  const isSubscribing = subscribeMutation.isPending || lwSubscribeMutation.isPending;

  // Get preview data from whichever query was used
  const previewData = feedSource === "lesswrong" ? lwPreviewQuery.data : previewQuery.data;

  return (
    <div className="mx-auto max-w-2xl px-4 py-4 sm:p-6">
      <h1 className="ui-text-xl sm:ui-text-2xl mb-4 font-bold text-zinc-900 sm:mb-6 dark:text-zinc-50">
        Subscribe to Feed
      </h1>

      {step === "input" && (
        <div className="space-y-4">
          {/* Source selector */}
          <div className="rounded-lg border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-900">
            <label
              htmlFor="feed-source"
              className="ui-text-sm mb-2 block font-medium text-zinc-700 dark:text-zinc-300"
            >
              Feed Source
            </label>
            <select
              id="feed-source"
              value={feedSource}
              onChange={(e) => {
                setFeedSource(e.target.value as FeedSource);
                setDiscoveryError(null);
                setLwError(null);
              }}
              disabled={isLoading}
              className="ui-text-sm w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-zinc-900 focus:border-zinc-500 focus:ring-1 focus:ring-zinc-500 focus:outline-none dark:border-zinc-600 dark:bg-zinc-800 dark:text-zinc-100"
            >
              <option value="standard">Standard Feed (RSS/Atom)</option>
              <option value="lesswrong">LessWrong</option>
            </select>
          </div>

          {/* Standard feed input */}
          {feedSource === "standard" && (
            <div className="rounded-lg border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-900">
              <p className="ui-text-sm mb-4 text-zinc-600 dark:text-zinc-400">
                Enter the URL of an RSS or Atom feed, or a website that has a feed. We&apos;ll
                automatically discover the feed if possible.
              </p>

              {/* Show discovery error if no feeds were found */}
              {discoveryError && (
                <Alert variant="error" className="mb-4">
                  {discoveryError}
                </Alert>
              )}

              {/* Show preview error only if it's not a "should try discovery" type error */}
              {previewQuery.error && !shouldTryDiscovery(previewQuery.error) && (
                <Alert variant="error" className="mb-4">
                  {previewQuery.error.message}
                </Alert>
              )}

              {/* Show discover error if fetch itself failed */}
              {discoverQuery.error && (
                <Alert variant="error" className="mb-4">
                  {discoverQuery.error.message}
                </Alert>
              )}

              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  handlePreview();
                }}
                className="space-y-4"
              >
                <Input
                  id="url"
                  type="url"
                  label="Feed URL"
                  placeholder="https://example.com/feed.xml"
                  value={url}
                  onChange={(e) => {
                    setUrl(e.target.value);
                    if (urlError) setUrlError(undefined);
                    if (discoveryError) setDiscoveryError(null);
                  }}
                  error={urlError}
                  autoComplete="url"
                  disabled={isLoading}
                />

                <Button type="submit" className="w-full" loading={isLoading}>
                  Preview Feed
                </Button>
              </form>
            </div>
          )}

          {/* LessWrong feed input */}
          {feedSource === "lesswrong" && (
            <div className="rounded-lg border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-900">
              <p className="ui-text-sm mb-4 text-zinc-600 dark:text-zinc-400">
                Subscribe to posts from LessWrong. Choose a view and optionally filter by user or
                tag.
              </p>

              {lwError && (
                <Alert variant="error" className="mb-4">
                  {lwError}
                </Alert>
              )}

              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  handleLwPreview();
                }}
                className="space-y-4"
              >
                <div>
                  <label
                    htmlFor="lw-view"
                    className="ui-text-sm mb-1 block font-medium text-zinc-700 dark:text-zinc-300"
                  >
                    View
                  </label>
                  <select
                    id="lw-view"
                    value={lwView}
                    onChange={(e) => setLwView(e.target.value as LessWrongView)}
                    disabled={isLoading}
                    className="ui-text-sm w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-zinc-900 focus:border-zinc-500 focus:ring-1 focus:ring-zinc-500 focus:outline-none dark:border-zinc-600 dark:bg-zinc-800 dark:text-zinc-100"
                  >
                    {LESSWRONG_VIEW_OPTIONS.map((opt) => (
                      <option key={opt.value} value={opt.value}>
                        {opt.label}
                      </option>
                    ))}
                  </select>
                </div>

                {lwView === "userPosts" && (
                  <Input
                    id="lw-user-id"
                    label="LessWrong User ID"
                    placeholder="e.g. abc123XYZ..."
                    value={lwUserId}
                    onChange={(e) => {
                      setLwUserId(e.target.value);
                      if (lwError) setLwError(null);
                    }}
                    disabled={isLoading}
                  />
                )}

                {lwView === "tagRelevance" && (
                  <Input
                    id="lw-tag-id"
                    label="LessWrong Tag ID"
                    placeholder="e.g. abc123XYZ..."
                    value={lwTagId}
                    onChange={(e) => {
                      setLwTagId(e.target.value);
                      if (lwError) setLwError(null);
                    }}
                    disabled={isLoading}
                  />
                )}

                <Button type="submit" className="w-full" loading={isLoading}>
                  Preview Feed
                </Button>
              </form>
            </div>
          )}
        </div>
      )}

      {step === "discovery" && (
        <div className="space-y-4">
          {/* Discovery Results Card */}
          <div className="rounded-lg border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-900">
            <div className="mb-4 flex items-center gap-2">
              <svg
                className="h-5 w-5 text-green-600 dark:text-green-400"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"
                />
              </svg>
              <h2 className="ui-text-lg font-semibold text-zinc-900 dark:text-zinc-50">
                We found {discoveredFeeds.length} feed{discoveredFeeds.length !== 1 ? "s" : ""} on
                this site
              </h2>
            </div>

            <p className="ui-text-sm mb-4 text-zinc-600 dark:text-zinc-400">
              Select a feed to preview and subscribe:
            </p>

            {/* Show error if preview of selected feed failed */}
            {selectedFeedUrl && previewQuery.error && (
              <Alert variant="error" className="mb-4">
                {previewQuery.error.message}
              </Alert>
            )}

            {/* Feed selection list */}
            <div className="space-y-2">
              {discoveredFeeds.map((feed) => (
                <button
                  key={feed.url}
                  type="button"
                  onClick={() => handleSelectFeed(feed.url)}
                  disabled={isLoading}
                  className={`w-full rounded-lg border p-4 text-left transition-colors ${
                    selectedFeedUrl === feed.url
                      ? "border-zinc-900 bg-zinc-50 dark:border-zinc-100 dark:bg-zinc-800"
                      : "border-zinc-200 bg-white hover:border-zinc-300 hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:hover:border-zinc-600 dark:hover:bg-zinc-800"
                  } ${isLoading ? "cursor-not-allowed opacity-50" : ""}`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <p className="font-medium text-zinc-900 dark:text-zinc-50">
                          {feed.title || "Untitled Feed"}
                        </p>
                        <span className="ui-text-xs inline-flex items-center rounded-full bg-zinc-100 px-2 py-0.5 font-medium text-zinc-700 dark:bg-zinc-700 dark:text-zinc-300">
                          {getFeedTypeLabel(feed.type)}
                        </span>
                      </div>
                      <p className="ui-text-xs mt-1 truncate font-mono text-zinc-500 dark:text-zinc-400">
                        {feed.url}
                      </p>
                    </div>
                    {selectedFeedUrl === feed.url && isLoading ? (
                      <svg
                        className="h-5 w-5 animate-spin text-zinc-500"
                        fill="none"
                        viewBox="0 0 24 24"
                      >
                        <circle
                          className="opacity-25"
                          cx="12"
                          cy="12"
                          r="10"
                          stroke="currentColor"
                          strokeWidth="4"
                        />
                        <path
                          className="opacity-75"
                          fill="currentColor"
                          d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                        />
                      </svg>
                    ) : (
                      <svg
                        className="h-5 w-5 text-zinc-400"
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={2}
                          d="M9 5l7 7-7 7"
                        />
                      </svg>
                    )}
                  </div>
                </button>
              ))}
            </div>
          </div>

          {/* Back button */}
          <div className="flex">
            <Button variant="secondary" onClick={handleBack} disabled={isLoading}>
              Back
            </Button>
          </div>
        </div>
      )}

      {step === "preview" && (
        <div className="space-y-4">
          {/* Feed Preview Card */}
          <div className="rounded-lg border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-900">
            <div className="mb-4 flex items-start justify-between">
              <div>
                <h2 className="ui-text-xl font-semibold text-zinc-900 dark:text-zinc-50">
                  {previewData?.feed.title ?? "Untitled Feed"}
                </h2>
                {previewData?.feed.siteUrl && (
                  <a
                    href={previewData.feed.siteUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="ui-text-sm text-zinc-500 hover:underline dark:text-zinc-400"
                  >
                    {new URL(previewData.feed.siteUrl).hostname}
                  </a>
                )}
              </div>
            </div>

            {previewData?.feed.description && (
              <p className="ui-text-sm mb-4 text-zinc-600 dark:text-zinc-400">
                {previewData.feed.description}
              </p>
            )}

            <p className="ui-text-xs text-zinc-500 dark:text-zinc-400">
              Feed URL: <span className="font-mono">{previewData?.feed.url}</span>
            </p>
          </div>

          {/* Sample Entries */}
          {previewData?.feed.sampleEntries && previewData.feed.sampleEntries.length > 0 && (
            <div className="rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
              <h3 className="ui-text-sm border-b border-zinc-200 px-4 py-3 font-medium text-zinc-900 dark:border-zinc-800 dark:text-zinc-50">
                Recent Entries
              </h3>
              <ul className="divide-y divide-zinc-200 dark:divide-zinc-800">
                {previewData.feed.sampleEntries.map((entry, index) => (
                  <li key={entry.guid ?? index} className="px-4 py-3">
                    <div className="flex items-start justify-between gap-4">
                      <div className="min-w-0 flex-1">
                        <p className="font-medium text-zinc-900 dark:text-zinc-50">
                          {entry.title ?? "Untitled"}
                        </p>
                        {entry.summary && (
                          <p className="ui-text-sm mt-1 line-clamp-2 text-zinc-600 dark:text-zinc-400">
                            {entry.summary}
                          </p>
                        )}
                      </div>
                      {entry.pubDate && (
                        <span className="ui-text-xs shrink-0 text-zinc-500 dark:text-zinc-400">
                          {formatDate(entry.pubDate)}
                        </span>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Error from subscribe */}
          {(subscribeMutation.error || lwSubscribeMutation.error) && (
            <Alert variant="error">
              {subscribeMutation.error?.message ?? lwSubscribeMutation.error?.message}
            </Alert>
          )}

          {/* Actions */}
          <div className="flex gap-3">
            <Button variant="secondary" onClick={handleBack} disabled={isSubscribing}>
              Back
            </Button>
            <Button className="flex-1" onClick={handleSubscribe} loading={isSubscribing}>
              Subscribe
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
