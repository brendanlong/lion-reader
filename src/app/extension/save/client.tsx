"use client";

/**
 * Client component for the extension save page.
 * Shows status messages during the save flow.
 */

interface Props {
  status: "loading" | "success" | "error";
  error?: string;
  url?: string;
  canRetry?: boolean;
}

export function ExtensionSaveClient({ status, error, url, canRetry }: Props) {
  if (status === "loading") {
    return (
      <div className="bg-canvas flex min-h-screen items-center justify-center">
        <div className="p-8 text-center">
          <div className="mx-auto mb-4 h-12 w-12 animate-spin rounded-full border-b-2 border-zinc-900 dark:border-zinc-100" />
          <p className="text-muted">Saving article...</p>
        </div>
      </div>
    );
  }

  if (status === "error") {
    return (
      <div className="bg-canvas flex min-h-screen items-center justify-center">
        <div className="max-w-md p-8 text-center">
          <div className="text-danger mb-4 text-5xl">!</div>
          <h1 className="ui-text-xl text-strong mb-2 font-semibold">Failed to Save</h1>
          <p className="text-muted mb-4">
            {error || "An error occurred while saving the article."}
          </p>
          {url && <p className="ui-text-sm text-muted mb-4 break-all">{url}</p>}
          {canRetry && url && (
            <a
              href={`/extension/save?url=${encodeURIComponent(url)}`}
              className="btn-primary inline-block rounded-lg px-4 py-2"
            >
              Try Again
            </a>
          )}
          <p className="ui-text-sm mt-6 text-zinc-400 dark:text-zinc-600">
            You can close this tab and try again from the extension.
          </p>
        </div>
      </div>
    );
  }

  // Success is handled by redirect, but just in case:
  return (
    <div className="bg-canvas flex min-h-screen items-center justify-center">
      <div className="p-8 text-center">
        <div className="text-success mb-4 text-5xl">✓</div>
        <p className="text-muted">Article saved!</p>
      </div>
    </div>
  );
}
