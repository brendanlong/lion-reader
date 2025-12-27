/**
 * Save Page (Bookmarklet Target)
 *
 * Minimal popup UI for saving URLs via the bookmarklet.
 * - Extracts `url` query parameter
 * - Calls saved.save API
 * - Shows loading, success, or error state
 * - Auto-closes on success after a delay
 */

"use client";

import { Suspense, useEffect, useState, useRef } from "react";
import { useSearchParams } from "next/navigation";
import { trpc } from "@/lib/trpc/client";
import { Button, Alert } from "@/components/ui";

export default function SavePage() {
  return (
    <Suspense>
      <SaveContent />
    </Suspense>
  );
}

function SaveContent() {
  const searchParams = useSearchParams();
  const urlToSave = searchParams.get("url");

  const [articleTitle, setArticleTitle] = useState<string | null>(null);
  const [countdown, setCountdown] = useState(3);

  // Track if we've already initiated the save to prevent re-triggering
  const saveInitiatedRef = useRef(false);

  const saveMutation = trpc.saved.save.useMutation({
    onSuccess: (data) => {
      setArticleTitle(data.article.title);
    },
  });

  // Start saving when URL is present (only once)
  useEffect(() => {
    if (urlToSave && !saveInitiatedRef.current) {
      saveInitiatedRef.current = true;
      saveMutation.mutate({ url: urlToSave });
    }
  }, [urlToSave, saveMutation]);

  // Auto-close countdown on success
  useEffect(() => {
    if (!saveMutation.isSuccess) return;

    const interval = setInterval(() => {
      setCountdown((prev) => {
        if (prev <= 1) {
          clearInterval(interval);
          window.close();
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    return () => clearInterval(interval);
  }, [saveMutation.isSuccess]);

  // Handle manual close
  const handleClose = () => {
    window.close();
  };

  // Handle retry
  const handleRetry = () => {
    if (urlToSave) {
      saveMutation.mutate({ url: urlToSave });
    }
  };

  // No URL provided
  if (!urlToSave) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center bg-zinc-50 p-4 dark:bg-zinc-950">
        <div className="w-full max-w-sm rounded-lg border border-zinc-200 bg-white p-6 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
          <div className="text-center">
            <h1 className="text-lg font-semibold text-zinc-900 dark:text-zinc-50">
              Save to Lion Reader
            </h1>
            <Alert variant="error" className="mt-4">
              No URL provided. Use the bookmarklet to save pages.
            </Alert>
            <Button variant="secondary" className="mt-4 w-full" onClick={handleClose}>
              Close
            </Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-zinc-50 p-4 dark:bg-zinc-950">
      <div className="w-full max-w-sm rounded-lg border border-zinc-200 bg-white p-6 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
        <div className="text-center">
          <h1 className="text-lg font-semibold text-zinc-900 dark:text-zinc-50">
            Save to Lion Reader
          </h1>

          {/* Saving State (includes idle and pending) */}
          {(saveMutation.isIdle || saveMutation.isPending) && (
            <div className="mt-6">
              <div className="flex justify-center">
                <svg
                  className="h-8 w-8 animate-spin text-zinc-600 dark:text-zinc-400"
                  xmlns="http://www.w3.org/2000/svg"
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
              </div>
              <p className="mt-3 text-sm text-zinc-600 dark:text-zinc-400">Saving article...</p>
              <p className="mt-2 truncate text-xs text-zinc-500 dark:text-zinc-500">{urlToSave}</p>
            </div>
          )}

          {/* Success State */}
          {saveMutation.isSuccess && (
            <div className="mt-6">
              <div className="flex justify-center">
                <svg
                  className="h-8 w-8 text-green-600 dark:text-green-500"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth={2}
                >
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                </svg>
              </div>
              <p className="mt-3 text-sm font-medium text-green-700 dark:text-green-400">
                Saved successfully!
              </p>
              {articleTitle && (
                <p className="mt-2 line-clamp-2 text-sm text-zinc-600 dark:text-zinc-400">
                  {articleTitle}
                </p>
              )}
              <p className="mt-4 text-xs text-zinc-500 dark:text-zinc-500">
                Closing in {countdown}...
              </p>
              <Button variant="secondary" className="mt-3 w-full" onClick={handleClose}>
                Close Now
              </Button>
            </div>
          )}

          {/* Error State */}
          {saveMutation.isError && (
            <div className="mt-6">
              <div className="flex justify-center">
                <svg
                  className="h-8 w-8 text-red-600 dark:text-red-500"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth={2}
                >
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </div>
              <Alert variant="error" className="mt-4 text-left">
                {saveMutation.error?.message || "Failed to save article"}
              </Alert>
              <p className="mt-2 truncate text-xs text-zinc-500 dark:text-zinc-500">{urlToSave}</p>
              <div className="mt-4 flex gap-2">
                <Button variant="secondary" className="flex-1" onClick={handleClose}>
                  Close
                </Button>
                <Button variant="primary" className="flex-1" onClick={handleRetry}>
                  Retry
                </Button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
