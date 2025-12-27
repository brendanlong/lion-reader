/**
 * Subscribe Page
 *
 * Allows users to subscribe to new feeds.
 * Provides URL input with feed preview before confirming subscription.
 */

"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { trpc } from "@/lib/trpc/client";
import { Button, Input, Alert } from "@/components/ui";

export default function SubscribePage() {
  const router = useRouter();
  const [url, setUrl] = useState("");
  const [urlError, setUrlError] = useState<string | undefined>();
  const [step, setStep] = useState<"input" | "preview">("input");

  const utils = trpc.useUtils();

  // Preview query - only runs when we explicitly call refetch
  const previewQuery = trpc.feeds.preview.useQuery(
    { url },
    {
      enabled: false,
      retry: false,
    }
  );

  // Subscribe mutation
  const subscribeMutation = trpc.subscriptions.create.useMutation({
    onSuccess: () => {
      utils.subscriptions.list.invalidate();
      router.push("/all");
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

  const handlePreview = async () => {
    if (!validateUrl(url)) {
      return;
    }

    const result = await previewQuery.refetch();
    if (result.data) {
      setStep("preview");
    }
  };

  const handleSubscribe = () => {
    subscribeMutation.mutate({ url: previewQuery.data?.feed.url ?? url });
  };

  const handleBack = () => {
    setStep("input");
  };

  const formatDate = (date: Date | null) => {
    if (!date) return "Unknown";
    return new Intl.DateTimeFormat("en-US", {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(date);
  };

  return (
    <div className="mx-auto max-w-2xl px-4 py-4 sm:p-6">
      <h1 className="mb-4 text-xl font-bold text-zinc-900 sm:mb-6 sm:text-2xl dark:text-zinc-50">
        Subscribe to Feed
      </h1>

      {step === "input" ? (
        <div className="rounded-lg border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-900">
          <p className="mb-4 text-sm text-zinc-600 dark:text-zinc-400">
            Enter the URL of an RSS or Atom feed, or a website that has a feed. We&apos;ll
            automatically discover the feed if possible.
          </p>

          {previewQuery.error && (
            <Alert variant="error" className="mb-4">
              {previewQuery.error.message}
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
              }}
              error={urlError}
              autoComplete="url"
              disabled={previewQuery.isFetching}
            />

            <Button type="submit" className="w-full" loading={previewQuery.isFetching}>
              Preview Feed
            </Button>
          </form>
        </div>
      ) : (
        <div className="space-y-4">
          {/* Feed Preview Card */}
          <div className="rounded-lg border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-900">
            <div className="mb-4 flex items-start justify-between">
              <div>
                <h2 className="text-xl font-semibold text-zinc-900 dark:text-zinc-50">
                  {previewQuery.data?.feed.title ?? "Untitled Feed"}
                </h2>
                {previewQuery.data?.feed.siteUrl && (
                  <a
                    href={previewQuery.data.feed.siteUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-sm text-zinc-500 hover:underline dark:text-zinc-400"
                  >
                    {new URL(previewQuery.data.feed.siteUrl).hostname}
                  </a>
                )}
              </div>
            </div>

            {previewQuery.data?.feed.description && (
              <p className="mb-4 text-sm text-zinc-600 dark:text-zinc-400">
                {previewQuery.data.feed.description}
              </p>
            )}

            <p className="text-xs text-zinc-500 dark:text-zinc-400">
              Feed URL: <span className="font-mono">{previewQuery.data?.feed.url}</span>
            </p>
          </div>

          {/* Sample Entries */}
          {previewQuery.data?.feed.sampleEntries &&
            previewQuery.data.feed.sampleEntries.length > 0 && (
              <div className="rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
                <h3 className="border-b border-zinc-200 px-4 py-3 text-sm font-medium text-zinc-900 dark:border-zinc-800 dark:text-zinc-50">
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
                            <p className="mt-1 line-clamp-2 text-sm text-zinc-600 dark:text-zinc-400">
                              {entry.summary}
                            </p>
                          )}
                        </div>
                        {entry.pubDate && (
                          <span className="shrink-0 text-xs text-zinc-500 dark:text-zinc-400">
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
