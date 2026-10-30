/**
 * Save Page (Bookmarklet & Share Target)
 *
 * Minimal popup UI for saving URLs via:
 * - Bookmarklet: passes URL as query parameter
 * - PWA Share Target: service worker extracts URL and redirects here with ?url=...
 *
 * - Calls saved.save, or for a shared file saved.uploadFile (an ebook:
 *   collections.importEbook)
 * - Shows loading, success, or error state
 * - Auto-closes on success after a delay
 */

"use client";

import { Suspense, useCallback, useEffect, useState, useRef, type ReactNode } from "react";
import { useSearchParams } from "next/navigation";
import { trpc } from "@/lib/trpc/client";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/alert";
import { SpinnerIcon, CheckIcon, LockIcon, CloseIcon } from "@/components/ui/icons";
import { isEbookFile } from "@/lib/upload-file-types";

export default function SavePage() {
  return (
    <Suspense>
      <SaveContent />
    </Suspense>
  );
}

interface SharedFile {
  content: string;
  /** The MIME type the sharing app gave it. */
  type?: string;
  filename: string;
  title?: string;
  /** Generated once per shared file, so a retry can't save it twice. */
  idempotencyKey: string;
}

const SHARE_DB_NAME = "lion-reader-share";
const SHARE_STORE = "files";
const SHARED_FILE_KEY = "pending";

/** Runs one request against the store the share-target service worker leaves files in. */
function shareStoreRequest<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>
): Promise<T> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(SHARE_DB_NAME, 1);
    // Opening creates the database if it's missing; give it the store too, or
    // the service worker's open at the same version would find none to fill.
    open.onupgradeneeded = () => open.result.createObjectStore(SHARE_STORE);
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const request = run(db.transaction(SHARE_STORE, mode).objectStore(SHARE_STORE));
      request.onsuccess = () => {
        db.close();
        resolve(request.result);
      };
      request.onerror = () => {
        db.close();
        reject(request.error);
      };
    };
  });
}

/** The file the share-target service worker stashed, or null if there's none. */
async function readSharedFile(): Promise<SharedFile | null> {
  const record = (await shareStoreRequest("readonly", (store) => store.get(SHARED_FILE_KEY))) as
    Omit<SharedFile, "idempotencyKey"> | undefined;
  return record ? { ...record, idempotencyKey: crypto.randomUUID() } : null;
}

/** Drop the shared file once it's saved; until then it survives a sign-in round-trip. */
function deleteSharedFile(): void {
  shareStoreRequest("readwrite", (store) => store.delete(SHARED_FILE_KEY)).catch((error: unknown) =>
    console.error("Failed to delete the shared file:", error)
  );
}

function SaveCard({ children }: { children: ReactNode }) {
  return (
    <div className="bg-canvas flex min-h-screen flex-col items-center justify-center p-4">
      <div className="border-edge bg-surface w-full max-w-sm rounded-lg border p-6 shadow-sm">
        <div className="text-center">
          <h1 className="ui-text-lg text-body font-semibold">Save to Lion Reader</h1>
          {children}
        </div>
      </div>
    </div>
  );
}

function SaveContent() {
  const searchParams = useSearchParams();
  const urlToSave = searchParams.get("url");
  const shareType = searchParams.get("type");
  const shareError = searchParams.get("error");

  const [articleTitle, setArticleTitle] = useState<string | null>(null);
  const [countdown, setCountdown] = useState(3);
  const [isRequestingPermission, setIsRequestingPermission] = useState(false);
  const [sharedFileMissing, setSharedFileMissing] = useState(false);

  // Track if we've already initiated the save to prevent re-triggering
  const saveInitiatedRef = useRef(false);
  const sharedFileRef = useRef<SharedFile | null>(null);

  const saveMutation = trpc.saved.save.useMutation({
    onSuccess: (data) => {
      setArticleTitle(data.article.title);
    },
    onError: (error) => {
      // The shared URL is actually a feed, not an article — send the user to the
      // Subscribe page pre-filled with it instead of failing the save. The
      // server signals this via the machine-readable `URL_IS_FEED` message (tRPC
      // doesn't ship the error `cause` to the client).
      if (error.message === "URL_IS_FEED" && urlToSave) {
        window.location.replace(`/subscribe?url=${encodeURIComponent(urlToSave)}`);
      }
    },
  });

  const uploadFileMutation = trpc.saved.uploadFile.useMutation({
    onSuccess: (data) => {
      deleteSharedFile();
      setArticleTitle(data.article.title);
    },
  });

  const importEbookMutation = trpc.collections.importEbook.useMutation({
    onSuccess: ({ subscription, entryIds }) => {
      deleteSharedFile();
      const chapters = `${entryIds.length} chapter${entryIds.length === 1 ? "" : "s"}`;
      setArticleTitle(subscription.title ? `${subscription.title} (${chapters})` : chapters);
    },
  });
  const [sharedEbook, setSharedEbook] = useState(false);

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

  // Determine which mutation is active (URL save or file upload)
  const activeMutation =
    shareType !== "file" ? saveMutation : sharedEbook ? importEbookMutation : uploadFileMutation;

  // Check if returning from OAuth flow
  useEffect(() => {
    const pendingUrl = sessionStorage.getItem("pendingSaveUrl");
    if (pendingUrl && !urlToSave) {
      // Clear the pending URL and redirect back to save with the original URL
      sessionStorage.removeItem("pendingSaveUrl");
      // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- deliberate hard nav: re-enters /save from scratch after the sign-in round-trip (see src/CLAUDE.md)
      window.location.href = `/save?url=${encodeURIComponent(pendingUrl)}`;
    }
  }, [urlToSave]);

  const importEbook = importEbookMutation.mutate;
  const uploadFile = uploadFileMutation.mutate;
  const uploadSharedFile = useCallback(
    (file: SharedFile) => {
      if (isEbookFile(file.filename, file.type)) {
        setSharedEbook(true);
        importEbook({ content: file.content, filename: file.filename });
      } else {
        const { content, filename, title, idempotencyKey } = file;
        uploadFile({ content, filename, title, idempotencyKey });
      }
    },
    [importEbook, uploadFile]
  );

  // Handle file upload from IndexedDB
  useEffect(() => {
    if (shareType === "file" && !saveInitiatedRef.current) {
      saveInitiatedRef.current = true;

      readSharedFile().then(
        (file) => {
          if (!file) {
            setSharedFileMissing(true);
            return;
          }
          sharedFileRef.current = file;
          uploadSharedFile(file);
        },
        (error: unknown) => {
          console.error("Failed to read the shared file:", error);
          setSharedFileMissing(true);
        }
      );
    }
  }, [shareType, uploadSharedFile]);

  // Start saving when URL is present (only once)
  useEffect(() => {
    if (urlToSave && !saveInitiatedRef.current) {
      saveInitiatedRef.current = true;
      saveMutation.mutate({ url: urlToSave });
    }
  }, [urlToSave, saveMutation]);

  // Auto-close countdown on success (for either mutation)
  useEffect(() => {
    if (!activeMutation.isSuccess) return;

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
  }, [activeMutation.isSuccess]);

  // Handle manual close
  const handleClose = () => {
    window.close();
  };

  // Handle retry
  const handleRetry = () => {
    if (urlToSave) {
      saveInitiatedRef.current = false;
      saveMutation.mutate({ url: urlToSave });
    } else if (shareType === "file" && sharedFileRef.current) {
      uploadSharedFile(sharedFileRef.current);
    }
  };

  // Handle Google Docs permission request
  const handleRequestPermission = () => {
    setIsRequestingPermission(true);
    requestGoogleDocsAccessMutation.mutate({});
  };

  // The shared URL turned out to be a feed; we're redirecting to /subscribe.
  // Keep showing a spinner rather than flashing the error card.
  const isFeedRedirect = activeMutation.error?.message === "URL_IS_FEED";

  // Check if error is an auth error (session expired, revoked, etc.)
  const isAuthError = activeMutation.error?.data?.code === "UNAUTHORIZED";

  // Check if error is a Google Docs permission error
  const errorMessage = activeMutation.error?.message || "";
  const needsDocsPermission = errorMessage === "NEEDS_DOCS_PERMISSION";
  const needsGoogleSignin = errorMessage === "NEEDS_GOOGLE_SIGNIN";
  const needsGoogleReauth = errorMessage === "NEEDS_GOOGLE_REAUTH";

  // Handle sign in - redirects to login (a stale httpOnly session cookie is inert
  // and is overwritten on the next login)
  const handleSignIn = () => {
    // Store the URL to save after login
    if (urlToSave) {
      sessionStorage.setItem("pendingSaveUrl", urlToSave);
    }
    // A shared file waits in IndexedDB, so coming back to it is enough.
    const returnTo = shareType === "file" ? "/save?type=file" : "/save";
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- deliberate hard nav across an auth boundary (see src/CLAUDE.md)
    window.location.href = `/login?redirect=${encodeURIComponent(returnTo)}`;
  };

  // Share error, no URL/file provided, or the shared file never arrived
  if ((!urlToSave && shareType !== "file") || sharedFileMissing) {
    const errorMessages: Record<string, string> = {
      no_url: "No URL was found in the shared content.",
      no_url_or_file: "No URL or file was found in the shared content.",
      share_failed: "Failed to process the shared content.",
      file_missing: "The shared file didn't reach Lion Reader. Try sharing it again.",
    };
    const error = sharedFileMissing ? "file_missing" : shareError;

    return (
      <SaveCard>
        <Alert variant="error" className="mt-4">
          {error
            ? errorMessages[error] || "An error occurred."
            : "No URL or file provided. Use the bookmarklet or share from another app."}
        </Alert>
        <Button variant="secondary" className="mt-4 w-full" onClick={handleClose}>
          Close
        </Button>
      </SaveCard>
    );
  }

  return (
    <SaveCard>
      {/* Saving State (includes idle, pending, and the feed→subscribe redirect) */}
      {(activeMutation.isIdle || activeMutation.isPending || isFeedRedirect) && (
        <div className="mt-6">
          <div className="flex justify-center">
            <SpinnerIcon className="text-muted h-8 w-8" />
          </div>
          <p className="ui-text-sm text-muted mt-3">
            {isFeedRedirect
              ? "This is a feed — opening Subscribe..."
              : shareType === "file"
                ? "Uploading file..."
                : "Saving article..."}
          </p>
          {urlToSave && <p className="ui-text-xs text-muted mt-2 truncate">{urlToSave}</p>}
        </div>
      )}

      {/* Success State */}
      {activeMutation.isSuccess && (
        <div className="mt-6">
          <div className="flex justify-center">
            <CheckIcon className="text-success h-8 w-8" />
          </div>
          <p className="ui-text-sm text-success mt-3 font-medium">Saved successfully!</p>
          {articleTitle && (
            <p className="ui-text-sm text-muted mt-2 line-clamp-2">{articleTitle}</p>
          )}
          <p className="ui-text-xs text-muted mt-4">Closing in {countdown}...</p>
          <Button variant="secondary" className="mt-3 w-full" onClick={handleClose}>
            Close Now
          </Button>
        </div>
      )}

      {/* Error State */}
      {activeMutation.isError && !isFeedRedirect && (
        <div className="mt-6">
          {/* Authentication Required */}
          {isAuthError ? (
            <>
              <div className="flex justify-center">
                <LockIcon className="text-warning h-8 w-8" />
              </div>
              <Alert variant="warning" className="mt-4 text-left">
                Your session has expired. Please sign in again to save this article.
              </Alert>
              <p className="ui-text-xs text-muted mt-2 truncate">{urlToSave}</p>
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
                <LockIcon className="text-info h-8 w-8" />
              </div>
              <Alert variant="error" className="mt-4 text-left">
                {needsDocsPermission
                  ? "This is a private Google Doc. You need to grant permission to access your Google Docs."
                  : needsGoogleReauth
                    ? "Your Google account session has expired. Please reconnect to access private Google Docs."
                    : "This is a private Google Doc. You need to sign in with Google to save it."}
              </Alert>
              <p className="ui-text-xs text-muted mt-2 truncate">{urlToSave}</p>
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
                  {requestGoogleDocsAccessMutation.error?.message || "Failed to request permission"}
                </Alert>
              )}
            </>
          ) : (
            <>
              {/* General Error */}
              <div className="flex justify-center">
                <CloseIcon className="text-danger h-8 w-8" />
              </div>
              <Alert variant="error" className="mt-4 text-left">
                {activeMutation.error?.message ||
                  (shareType === "file" ? "Failed to upload file" : "Failed to save article")}
              </Alert>
              {urlToSave && <p className="ui-text-xs text-muted mt-2 truncate">{urlToSave}</p>}
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
    </SaveCard>
  );
}
