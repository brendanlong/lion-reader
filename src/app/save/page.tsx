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
  const [isRequestingPermission, setIsRequestingPermission] = useState(false);

  // Track if we've already initiated the save to prevent re-triggering
  const saveInitiatedRef = useRef(false);

  const saveMutation = trpc.saved.save.useMutation({
    onSuccess: (data) => {
      setArticleTitle(data.article.title);
    },
  });

  const requestGoogleDocsAccessMutation = trpc.auth.requestGoogleDocsAccess.useMutation({
    onSuccess: (data) => {
      // Store the URL we're trying to save so we can retry after OAuth
      if (urlToSave) {
        sessionStorage.setItem("pendingSaveUrl", urlToSave);
      }
      // Redirect to Google OAuth consent screen
      window.location.href = data.url;
    },
    onError: () => {
      setIsRequestingPermission(false);
      // The error will be displayed in the UI
    },
  });

  // Check if returning from OAuth flow
  useEffect(() => {
    const pendingUrl = sessionStorage.getItem("pendingSaveUrl");
    if (pendingUrl && !urlToSave) {
      // Clear the pending URL and redirect back to save with the original URL
      sessionStorage.removeItem("pendingSaveUrl");
      window.location.href = `/save?url=${encodeURIComponent(pendingUrl)}`;
    }
  }, [urlToSave]);

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
      saveInitiatedRef.current = false;
      saveMutation.mutate({ url: urlToSave });
    }
  };

  // Handle Google Docs permission request
  const handleRequestPermission = () => {
    setIsRequestingPermission(true);
    requestGoogleDocsAccessMutation.mutate({});
  };

  // Check if error is an auth error (session expired, revoked, etc.)
  const isAuthError = saveMutation.error?.data?.code === "UNAUTHORIZED";

  // Check if error is a Google Docs permission error
  const errorMessage = saveMutation.error?.message || "";
  const needsDocsPermission = errorMessage === "NEEDS_DOCS_PERMISSION";
  const needsGoogleSignin = errorMessage === "NEEDS_GOOGLE_SIGNIN";
  const needsGoogleReauth = errorMessage === "NEEDS_GOOGLE_REAUTH";

  // Handle sign in - clears any stale session and redirects to login
  const handleSignIn = () => {
    // Clear any existing session cookie (it's invalid anyway)
    document.cookie = "session=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT";
    // Store the URL to save after login
    if (urlToSave) {
      sessionStorage.setItem("pendingSaveUrl", urlToSave);
    }
    // Redirect to login, which will redirect back to /save after auth
    window.location.href = `/login?redirect=${encodeURIComponent("/save")}`;
  };

  // No URL provided
  if (!urlToSave) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center bg-zinc-50 p-4 dark:bg-zinc-950">
        <div className="w-full max-w-sm rounded-lg border border-zinc-200 bg-white p-6 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
          <div className="text-center">
            <h1 className="ui-text-lg font-semibold text-zinc-900 dark:text-zinc-50">
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
          <h1 className="ui-text-lg font-semibold text-zinc-900 dark:text-zinc-50">
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
              <p className="ui-text-sm mt-3 text-zinc-600 dark:text-zinc-400">Saving article...</p>
              <p className="ui-text-xs mt-2 truncate text-zinc-500 dark:text-zinc-500">
                {urlToSave}
              </p>
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
              <p className="ui-text-sm mt-3 font-medium text-green-700 dark:text-green-400">
                Saved successfully!
              </p>
              {articleTitle && (
                <p className="ui-text-sm mt-2 line-clamp-2 text-zinc-600 dark:text-zinc-400">
                  {articleTitle}
                </p>
              )}
              <p className="ui-text-xs mt-4 text-zinc-500 dark:text-zinc-500">
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
              {/* Authentication Required */}
              {isAuthError ? (
                <>
                  <div className="flex justify-center">
                    <svg
                      className="h-8 w-8 text-amber-600 dark:text-amber-500"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                      strokeWidth={2}
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"
                      />
                    </svg>
                  </div>
                  <Alert variant="warning" className="mt-4 text-left">
                    Your session has expired. Please sign in again to save this article.
                  </Alert>
                  <p className="ui-text-xs mt-2 truncate text-zinc-500 dark:text-zinc-500">
                    {urlToSave}
                  </p>
                  <div className="mt-4 flex gap-2">
                    <Button variant="secondary" className="flex-1" onClick={handleClose}>
                      Close
                    </Button>
                    <Button variant="primary" className="flex-1" onClick={handleSignIn}>
                      Sign In
                    </Button>
                  </div>
                </>
              ) : /* Google Docs Permission Required */
              needsDocsPermission || needsGoogleSignin || needsGoogleReauth ? (
                <>
                  <div className="flex justify-center">
                    <svg
                      className="h-8 w-8 text-blue-600 dark:text-blue-500"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                      strokeWidth={2}
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"
                      />
                    </svg>
                  </div>
                  <Alert variant="error" className="mt-4 text-left">
                    {needsDocsPermission
                      ? "This is a private Google Doc. You need to grant permission to access your Google Docs."
                      : needsGoogleReauth
                        ? "Your Google account session has expired. Please reconnect to access private Google Docs."
                        : "This is a private Google Doc. You need to sign in with Google to save it."}
                  </Alert>
                  <p className="ui-text-xs mt-2 truncate text-zinc-500 dark:text-zinc-500">
                    {urlToSave}
                  </p>
                  <div className="mt-4 flex gap-2">
                    <Button variant="secondary" className="flex-1" onClick={handleClose}>
                      Close
                    </Button>
                    <Button
                      variant="primary"
                      className="flex-1"
                      onClick={handleRequestPermission}
                      disabled={isRequestingPermission || requestGoogleDocsAccessMutation.isPending}
                    >
                      {isRequestingPermission || requestGoogleDocsAccessMutation.isPending
                        ? "Redirecting..."
                        : needsDocsPermission
                          ? "Grant Permission"
                          : needsGoogleReauth
                            ? "Reconnect Google"
                            : "Sign in with Google"}
                    </Button>
                  </div>
                  {requestGoogleDocsAccessMutation.isError && (
                    <Alert variant="error" className="ui-text-sm mt-2 text-left">
                      {requestGoogleDocsAccessMutation.error?.message ||
                        "Failed to request permission"}
                    </Alert>
                  )}
                </>
              ) : (
                <>
                  {/* General Error */}
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
                  <p className="ui-text-xs mt-2 truncate text-zinc-500 dark:text-zinc-500">
                    {urlToSave}
                  </p>
                  <div className="mt-4 flex gap-2">
                    <Button variant="secondary" className="flex-1" onClick={handleClose}>
                      Close
                    </Button>
                    <Button variant="primary" className="flex-1" onClick={handleRetry}>
                      Retry
                    </Button>
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
