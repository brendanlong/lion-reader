/**
 * BookmarkletSettings Component
 *
 * Settings section for saving articles to Lion Reader.
 * Includes browser extension links (Chrome, Firefox) and the bookmarklet for other browsers.
 */

"use client";

import { useState, useMemo, useEffect, useRef } from "react";
import { SettingsSection } from "@/components/settings/SettingsSection";
import { CardSection } from "@/components/ui/card";
import { NoteBox } from "@/components/ui/note-box";
import {
  BookmarkIcon,
  ChevronRightIcon,
  ChromeIcon,
  FirefoxIcon,
} from "@/components/ui/icon-button";

export function BookmarkletSettings() {
  const [showCode, setShowCode] = useState(false);
  const bookmarkletRef = useRef<HTMLAnchorElement>(null);

  // Generate the bookmarklet URL using the app's base URL
  // Check env var first (available on both server and client), then fall back to window.location.origin
  const { bookmarkletHref, appUrl } = useMemo(() => {
    const baseUrl =
      process.env.NEXT_PUBLIC_APP_URL ||
      (typeof window !== "undefined" ? window.location.origin : "");

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
    <SettingsSection
      title="Save to Lion Reader"
      description="Save any webpage to Lion Reader with one click. The article will be added to your Saved section where you can read it later."
    >
      {/* Browser Extensions */}
      <div className="mt-6">
        <h3 className="ui-text-sm text-strong font-medium">Browser Extensions</h3>
        <p className="ui-text-sm text-muted mt-1">
          The easiest way to save articles from your browser.
        </p>
        <div className="mt-3 flex flex-wrap gap-3">
          <a
            href="https://chromewebstore.google.com/detail/lion-reader/mpjddkjjkckmclaifjfokjppfoenmlpl"
            target="_blank"
            rel="noopener noreferrer"
            className="ui-text-sm border-info-border bg-info-subtle text-info-subtle-foreground hover:border-info hover:bg-info-subtle inline-flex items-center gap-2 rounded-lg border px-4 py-2.5 font-medium shadow-sm transition-all hover:shadow"
          >
            <ChromeIcon className="h-4 w-4" />
            Install Chrome Extension
          </a>
          <a
            href="https://addons.mozilla.org/en-US/firefox/addon/lion-reader/"
            target="_blank"
            rel="noopener noreferrer"
            className="ui-text-sm border-warning-border bg-warning-subtle text-warning-subtle-foreground hover:border-warning hover:bg-warning-subtle inline-flex items-center gap-2 rounded-lg border px-4 py-2.5 font-medium shadow-sm transition-all hover:shadow"
          >
            <FirefoxIcon className="h-4 w-4" />
            Install Firefox Extension
          </a>
        </div>
      </div>

      {/* Bookmarklet Section */}
      <CardSection>
        <h3 className="ui-text-sm text-strong font-medium">Bookmarklet (Other Browsers)</h3>
        <p className="ui-text-sm text-muted mt-1">
          For Safari and other browsers, use the bookmarklet.
        </p>
      </CardSection>

      {/* Draggable Bookmarklet Link */}
      <div className="mt-4">
        <p className="ui-text-sm text-body mb-3">Drag this button to your bookmarks bar:</p>
        <a
          ref={bookmarkletRef}
          href="#"
          onClick={(e) => e.preventDefault()}
          draggable
          className="ui-text-sm border-warning-border bg-warning-subtle text-warning-subtle-foreground hover:border-warning hover:bg-warning-subtle inline-flex items-center gap-2 rounded-lg border px-4 py-2.5 font-medium shadow-sm transition-all hover:shadow active:scale-95"
        >
          <BookmarkIcon className="h-4 w-4" />
          Save to Lion Reader
        </a>
      </div>

      {/* Installation Instructions */}
      <NoteBox className="mt-6">
        <h3 className="ui-text-sm text-strong font-medium">Installation Instructions</h3>
        <ol className="ui-text-sm text-muted mt-2 list-inside list-decimal space-y-2">
          <li>Make sure your browser&apos;s bookmarks bar is visible</li>
          <li>
            Drag the <strong className="text-emphasis">&quot;Save to Lion Reader&quot;</strong>{" "}
            button above to your bookmarks bar
          </li>
          <li>
            When you find an article you want to save, click the bookmarklet in your bookmarks bar
          </li>
          <li>A popup will appear confirming the article has been saved</li>
        </ol>
      </NoteBox>

      {/* Show/Hide Code Section */}
      <CardSection>
        <button
          type="button"
          onClick={() => setShowCode(!showCode)}
          className="ui-text-sm text-body hover:text-strong inline-flex items-center gap-2 font-medium transition-colors"
        >
          <ChevronRightIcon
            className={`h-4 w-4 transition-transform ${showCode ? "rotate-90" : ""}`}
          />
          {showCode ? "Hide bookmarklet code" : "Show bookmarklet code"}
        </button>

        {showCode && (
          <div className="mt-4">
            <p className="ui-text-sm text-muted mb-2">
              If you prefer, you can manually create a bookmark with this JavaScript code:
            </p>
            <div className="relative">
              <pre className="ui-text-xs border-edge-strong bg-surface-muted text-emphasis overflow-x-auto rounded-md border p-3 font-mono">
                <code className="break-all whitespace-pre-wrap">{bookmarkletHref}</code>
              </pre>
              <button
                type="button"
                onClick={() => {
                  navigator.clipboard.writeText(bookmarkletHref);
                }}
                className="ui-text-xs border-edge-input absolute top-2 right-2 rounded border bg-white px-2 py-1 font-medium text-zinc-600 transition-colors hover:bg-zinc-50 hover:text-zinc-900 dark:bg-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-600 dark:hover:text-zinc-100"
              >
                Copy
              </button>
            </div>
          </div>
        )}
      </CardSection>

      {/* Note about app URL */}
      {appUrl && <p className="ui-text-xs text-faint mt-4">Bookmarklet configured for: {appUrl}</p>}
    </SettingsSection>
  );
}
