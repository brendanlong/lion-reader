/**
 * BookmarkletSettings Component
 *
 * Settings section for saving articles to Lion Reader.
 * Includes the Firefox extension link and the bookmarklet for other browsers.
 */

"use client";

import { useState, useMemo, useEffect, useRef } from "react";

export function BookmarkletSettings() {
  const [showCode, setShowCode] = useState(false);
  const bookmarkletRef = useRef<HTMLAnchorElement>(null);

  // Generate the bookmarklet URL using the app's base URL
  const { bookmarkletHref, appUrl } = useMemo(() => {
    // Use NEXT_PUBLIC_APP_URL if available, otherwise use window.location.origin
    const baseUrl =
      typeof window !== "undefined"
        ? process.env.NEXT_PUBLIC_APP_URL || window.location.origin
        : "";

    // The bookmarklet JavaScript - opens the save page in a popup window
    const bookmarkletCode = `javascript:(function(){window.open('${baseUrl}/save?url='+encodeURIComponent(location.href),'save','width=400,height=300')})();`;

    return {
      bookmarkletHref: bookmarkletCode,
      appUrl: baseUrl,
    };
  }, []);

  // Set the href directly on the DOM element to bypass React's javascript: URL blocking
  useEffect(() => {
    if (bookmarkletRef.current && bookmarkletHref) {
      bookmarkletRef.current.setAttribute("href", bookmarkletHref);
    }
  }, [bookmarkletHref]);

  return (
    <section>
      <h2 className="mb-4 text-xl font-semibold text-zinc-900 dark:text-zinc-50">
        Save to Lion Reader
      </h2>
      <div className="rounded-lg border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-900">
        {/* Description */}
        <p className="text-base text-zinc-600 dark:text-zinc-400">
          Save any webpage to Lion Reader with one click. The article will be added to your Saved
          section where you can read it later.
        </p>

        {/* Firefox Extension */}
        <div className="mt-6">
          <h3 className="text-base font-medium text-zinc-900 dark:text-zinc-100">
            Firefox Extension
          </h3>
          <p className="mt-1 text-base text-zinc-600 dark:text-zinc-400">
            The easiest way to save articles in Firefox.
          </p>
          <a
            href="https://addons.mozilla.org/en-US/firefox/addon/lion-reader/"
            target="_blank"
            rel="noopener noreferrer"
            className="mt-3 inline-flex items-center gap-2 rounded-lg border border-orange-300 bg-orange-50 px-4 py-2.5 text-base font-medium text-orange-800 shadow-sm transition-all hover:border-orange-400 hover:bg-orange-100 hover:shadow dark:border-orange-700 dark:bg-orange-950 dark:text-orange-200 dark:hover:border-orange-600 dark:hover:bg-orange-900"
          >
            <svg className="h-4 w-4" viewBox="0 0 24 24" fill="currentColor">
              <path d="M12.001 1.5c-.707 0-1.415.14-2.08.42L4.5 4.42A4.5 4.5 0 002 8.42v7.16a4.5 4.5 0 002.5 4l5.42 2.5c.665.28 1.373.42 2.08.42s1.415-.14 2.08-.42l5.42-2.5a4.5 4.5 0 002.5-4V8.42a4.5 4.5 0 00-2.5-4l-5.42-2.5A5.1 5.1 0 0012 1.5zm0 2c.45 0 .9.09 1.32.27l5.18 2.39c.96.44 1.5 1.38 1.5 2.42v6.84c0 1.04-.54 1.98-1.5 2.42l-5.18 2.39c-.42.18-.87.27-1.32.27s-.9-.09-1.32-.27l-5.18-2.39c-.96-.44-1.5-1.38-1.5-2.42V8.58c0-1.04.54-1.98 1.5-2.42l5.18-2.39c.42-.18.87-.27 1.32-.27z" />
            </svg>
            Install Firefox Extension
          </a>
        </div>

        {/* Bookmarklet Section */}
        <div className="mt-6 border-t border-zinc-200 pt-6 dark:border-zinc-700">
          <h3 className="text-base font-medium text-zinc-900 dark:text-zinc-100">
            Bookmarklet (Other Browsers)
          </h3>
          <p className="mt-1 text-base text-zinc-600 dark:text-zinc-400">
            For Chrome, Safari, and other browsers, use the bookmarklet.
          </p>
        </div>

        {/* Draggable Bookmarklet Link */}
        <div className="mt-4">
          <p className="mb-3 text-base text-zinc-700 dark:text-zinc-300">
            Drag this button to your bookmarks bar:
          </p>
          <a
            ref={bookmarkletRef}
            href="#"
            onClick={(e) => e.preventDefault()}
            draggable
            className="inline-flex items-center gap-2 rounded-lg border border-amber-300 bg-amber-50 px-4 py-2.5 text-base font-medium text-amber-800 shadow-sm transition-all hover:border-amber-400 hover:bg-amber-100 hover:shadow active:scale-95 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-200 dark:hover:border-amber-600 dark:hover:bg-amber-900"
          >
            <svg
              className="h-4 w-4"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
              strokeWidth={2}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M5 5a2 2 0 012-2h10a2 2 0 012 2v16l-7-3.5L5 21V5z"
              />
            </svg>
            Save to Lion Reader
          </a>
        </div>

        {/* Installation Instructions */}
        <div className="mt-6 rounded-md border border-zinc-200 bg-zinc-50 p-4 dark:border-zinc-700 dark:bg-zinc-800/50">
          <h3 className="text-base font-medium text-zinc-900 dark:text-zinc-100">
            Installation Instructions
          </h3>
          <ol className="mt-2 list-inside list-decimal space-y-2 text-base text-zinc-600 dark:text-zinc-400">
            <li>Make sure your browser&apos;s bookmarks bar is visible</li>
            <li>
              Drag the{" "}
              <strong className="text-zinc-900 dark:text-zinc-200">
                &quot;Save to Lion Reader&quot;
              </strong>{" "}
              button above to your bookmarks bar
            </li>
            <li>
              When you find an article you want to save, click the bookmarklet in your bookmarks bar
            </li>
            <li>A popup will appear confirming the article has been saved</li>
          </ol>
        </div>

        {/* Show/Hide Code Section */}
        <div className="mt-6 border-t border-zinc-200 pt-6 dark:border-zinc-700">
          <button
            type="button"
            onClick={() => setShowCode(!showCode)}
            className="inline-flex items-center gap-2 text-base font-medium text-zinc-700 transition-colors hover:text-zinc-900 dark:text-zinc-300 dark:hover:text-zinc-50"
          >
            <svg
              className={`h-4 w-4 transition-transform ${showCode ? "rotate-90" : ""}`}
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
            </svg>
            {showCode ? "Hide bookmarklet code" : "Show bookmarklet code"}
          </button>

          {showCode && (
            <div className="mt-4">
              <p className="mb-2 text-base text-zinc-500 dark:text-zinc-400">
                If you prefer, you can manually create a bookmark with this JavaScript code:
              </p>
              <div className="relative">
                <pre className="overflow-x-auto rounded-md border border-zinc-200 bg-zinc-100 p-3 font-mono text-xs text-zinc-800 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-200">
                  <code className="break-all whitespace-pre-wrap">{bookmarkletHref}</code>
                </pre>
                <button
                  type="button"
                  onClick={() => {
                    navigator.clipboard.writeText(bookmarkletHref);
                  }}
                  className="absolute top-2 right-2 rounded border border-zinc-300 bg-white px-2 py-1 text-xs font-medium text-zinc-600 transition-colors hover:bg-zinc-50 hover:text-zinc-900 dark:border-zinc-600 dark:bg-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-600 dark:hover:text-zinc-100"
                >
                  Copy
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Note about app URL */}
        {appUrl && (
          <p className="mt-4 text-sm text-zinc-400 dark:text-zinc-500">
            Bookmarklet configured for: {appUrl}
          </p>
        )}
      </div>
    </section>
  );
}
