"use client";

/**
 * Client component for the extension save page.
 * Shows the error when the save flow can't complete (success redirects instead).
 */

interface Props {
  error?: string;
  /** The URL being saved; when present, it's shown with a "Try Again" link. */
  url?: string;
}

export function ExtensionSaveClient({ error, url }: Props) {
  return (
    <div className="bg-canvas flex min-h-screen items-center justify-center">
      <div className="max-w-md p-8 text-center">
        <div className="text-danger mb-4 text-5xl">!</div>
        <h1 className="ui-text-xl text-body mb-2 font-semibold">Failed to Save</h1>
        <p className="text-muted mb-4">{error || "An error occurred while saving the article."}</p>
        {url && (
          <>
            <p className="ui-text-sm text-muted mb-4 break-all">{url}</p>
            <a
              href={`/extension/save?url=${encodeURIComponent(url)}`}
              className="btn-primary inline-block rounded-lg px-4 py-2"
            >
              Try Again
            </a>
          </>
        )}
        <p className="ui-text-sm text-faint mt-6">
          You can close this tab and try again from the extension.
        </p>
      </div>
    </div>
  );
}
