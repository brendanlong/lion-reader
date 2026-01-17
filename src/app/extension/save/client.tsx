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
      <div className="flex min-h-screen items-center justify-center bg-zinc-50 dark:bg-zinc-900">
        <div className="p-8 text-center">
          <div className="mx-auto mb-4 h-12 w-12 animate-spin rounded-full border-b-2 border-zinc-900 dark:border-zinc-100" />
          <p className="text-zinc-600 dark:text-zinc-400">Saving article...</p>
        </div>
      </div>
    );
  }

  if (status === "error") {
    return (
      <div className="flex min-h-screen items-center justify-center bg-zinc-50 dark:bg-zinc-900">
        <div className="max-w-md p-8 text-center">
          <div className="mb-4 text-5xl text-red-500">!</div>
          <h1 className="ui-text-xl mb-2 font-semibold text-zinc-900 dark:text-zinc-100">
            Failed to Save
          </h1>
          <p className="mb-4 text-zinc-600 dark:text-zinc-400">
            {error || "An error occurred while saving the article."}
          </p>
          {url && (
            <p className="ui-text-sm mb-4 break-all text-zinc-500 dark:text-zinc-500">{url}</p>
          )}
          {canRetry && url && (
            <a
              href={`/extension/save?url=${encodeURIComponent(url)}`}
              className="inline-block rounded-lg bg-zinc-900 px-4 py-2 text-white hover:opacity-90 dark:bg-zinc-100 dark:text-zinc-900"
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
    <div className="flex min-h-screen items-center justify-center bg-zinc-50 dark:bg-zinc-900">
      <div className="p-8 text-center">
        <div className="mb-4 text-5xl text-green-500">✓</div>
        <p className="text-zinc-600 dark:text-zinc-400">Article saved!</p>
      </div>
    </div>
  );
}
