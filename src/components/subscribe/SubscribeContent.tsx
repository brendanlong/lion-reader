/**
 * SubscribeContent Component
 *
 * Allows users to subscribe to new feeds.
 * Provides URL input with feed preview before confirming subscription.
 * If the URL is not a direct feed, automatically discovers feeds on the page.
 */

"use client";

import { useState, useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc/client";
import { handleSubscriptionCreated } from "@/lib/cache/operations";
import { clientPush } from "@/lib/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Alert } from "@/components/ui/alert";
import { CheckCircleIcon, SpinnerIcon, ChevronRightIcon } from "@/components/ui/icon-button";

// ============================================================================
// Types
// ============================================================================

interface DiscoveredFeed {
  url: string;
  type: "rss" | "atom" | "json" | "unknown";
  title?: string;
}

type Step = "input" | "discovery" | "preview";

// ============================================================================
// Component
// ============================================================================

export function SubscribeContent() {
  const queryClient = useQueryClient();
  const [url, setUrl] = useState("");
  const [urlError, setUrlError] = useState<string | undefined>();
  const [step, setStep] = useState<Step>("input");
  const [discoveredFeeds, setDiscoveredFeeds] = useState<DiscoveredFeed[]>([]);
  const [selectedFeedUrl, setSelectedFeedUrl] = useState<string | null>(null);
  const [discoveryError, setDiscoveryError] = useState<string | null>(null);

  const utils = trpc.useUtils();

  // Preview query - only runs when we explicitly call refetch
  const previewQuery = trpc.feeds.preview.useQuery(
    { url: selectedFeedUrl || url },
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

  // Subscribe mutation
  const subscribeMutation = trpc.subscriptions.create.useMutation({
    onSuccess: (data) => {
      // Use centralized cache operation for consistent behavior with SSE events
      handleSubscriptionCreated(utils, data, queryClient);
      clientPush("/all");
    },
    onError: () => {
      toast.error("Failed to subscribe to feed");
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
    subscribeMutation.mutate({ url: previewQuery.data?.feed.url ?? selectedFeedUrl ?? url });
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

  const isLoading = previewQuery.isFetching || discoverQuery.isFetching;

  return (
    <div className="mx-auto max-w-2xl px-4 py-4 sm:p-6">
      <h1 className="ui-text-xl sm:ui-text-2xl mb-4 font-bold text-zinc-900 sm:mb-6 dark:text-zinc-50">
        Subscribe to Feed
      </h1>

      {step === "input" && (
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

      {step === "discovery" && (
        <div className="space-y-4">
          {/* Discovery Results Card */}
          <div className="rounded-lg border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-900">
            <div className="mb-4 flex items-center gap-2">
              <CheckCircleIcon className="h-5 w-5 text-green-600 dark:text-green-400" />
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
                      <SpinnerIcon className="h-5 w-5 text-zinc-500" />
                    ) : (
                      <ChevronRightIcon className="h-5 w-5 text-zinc-400" />
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
                  {previewQuery.data?.feed.title ?? "Untitled Feed"}
                </h2>
                {previewQuery.data?.feed.siteUrl && (
                  <a
                    href={previewQuery.data.feed.siteUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="ui-text-sm text-zinc-500 hover:underline dark:text-zinc-400"
                  >
                    {new URL(previewQuery.data.feed.siteUrl).hostname}
                  </a>
                )}
              </div>
            </div>

            {previewQuery.data?.feed.description && (
              <p className="ui-text-sm mb-4 text-zinc-600 dark:text-zinc-400">
                {previewQuery.data.feed.description}
              </p>
            )}

            <p className="ui-text-xs text-zinc-500 dark:text-zinc-400">
              Feed URL: <span className="font-mono">{previewQuery.data?.feed.url}</span>
            </p>
          </div>

          {/* Sample Entries */}
          {previewQuery.data?.feed.sampleEntries &&
            previewQuery.data.feed.sampleEntries.length > 0 && (
              <div className="rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
                <h3 className="ui-text-sm border-b border-zinc-200 px-4 py-3 font-medium text-zinc-900 dark:border-zinc-800 dark:text-zinc-50">
                  Recent Entries
                </h3>
                <ul className="divide-y divide-zinc-200 dark:divide-zinc-800">
                  {previewQuery.data.feed.sampleEntries.map((entry, index) => (
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
          {subscribeMutation.error && (
            <Alert variant="error">{subscribeMutation.error.message}</Alert>
          )}

          {/* Actions */}
          <div className="flex gap-3">
            <Button variant="secondary" onClick={handleBack} disabled={subscribeMutation.isPending}>
              Back
            </Button>
            <Button
              className="flex-1"
              onClick={handleSubscribe}
              loading={subscribeMutation.isPending}
            >
              Subscribe
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
