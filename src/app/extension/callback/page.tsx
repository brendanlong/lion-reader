/**
 * Extension Callback Page
 *
 * This page is the target for extension redirects after saving.
 * The extension's webNavigation listener detects this URL and:
 * 1. Extracts the token from the URL
 * 2. Stores it for future API calls
 * 3. Closes the tab
 *
 * URL format: /extension/callback?status=success&token=...&title=...
 *            /extension/callback?status=error&error=...
 */

interface PageProps {
  searchParams: Promise<{
    status?: string;
    token?: string;
    title?: string;
    error?: string;
  }>;
}

export default async function ExtensionCallbackPage({ searchParams }: PageProps) {
  const params = await searchParams;
  const { status, title, error } = params;

  const isSuccess = status === "success";

  return (
    <div className="flex min-h-screen items-center justify-center bg-zinc-50 dark:bg-zinc-900">
      <div className="max-w-md p-8 text-center">
        {isSuccess ? (
          <>
            <div className="mb-4 text-5xl text-green-500">✓</div>
            <h1 className="ui-text-xl text-strong mb-2 font-semibold">Article Saved!</h1>
            {title && <p className="text-muted mb-4">{title}</p>}
            <p className="ui-text-sm text-zinc-400 dark:text-zinc-600">
              This tab will close automatically.
              <br />
              If it doesn&apos;t, you can close it manually.
            </p>
          </>
        ) : (
          <>
            <div className="mb-4 text-5xl text-red-500">!</div>
            <h1 className="ui-text-xl text-strong mb-2 font-semibold">Something Went Wrong</h1>
            <p className="text-muted mb-4">{error || "Failed to complete the save operation."}</p>
            <p className="ui-text-sm text-zinc-400 dark:text-zinc-600">
              Please close this tab and try again.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
