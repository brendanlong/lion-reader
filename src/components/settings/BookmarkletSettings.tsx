/**
 * BookmarkletSettings Component
 *
 * Settings section for saving articles to Lion Reader.
 * Includes browser extension links (Chrome, Firefox) and the bookmarklet for other browsers.
 */

"use client";

import { useState, useEffect, useRef } from "react";
import { useAppBaseUrl } from "@/lib/hooks/useAppBaseUrl";
import { SettingsSection } from "@/components/settings/SettingsSection";
import { CardSection } from "@/components/ui/card";
import { CodeBlock } from "@/components/ui/copy-button";
import { BookmarkIcon, ChevronRightIcon, ChromeIcon, FirefoxIcon } from "@/components/ui/icons";

export function BookmarkletSettings() {
  const [showCode, setShowCode] = useState(false);
  const bookmarkletRef = useRef<HTMLAnchorElement>(null);

  const appUrl = useAppBaseUrl();
  // The bookmarklet JavaScript - opens the save page in a popup window
  const bookmarkletHref = `javascript:(function(){window.open('${appUrl}/save?url='+encodeURIComponent(location.href),'save','width=400,height=300')})();`;

  // Set the href directly on the DOM element to bypass React's javascript: URL blocking
  useEffect(() => {
    if (bookmarkletRef.current && bookmarkletHref) {
      bookmarkletRef.current.setAttribute("href", bookmarkletHref);
    }
  }, [bookmarkletHref]);

  return (
    <SettingsSection
      title="Save to Lion Reader"
      description="Save any webpage to your Saved list to read later."
    >
      {/* Browser Extensions */}
      <div>
        <h3 className="ui-text-sm text-body font-medium">Browser Extensions</h3>
        <div className="mt-3 flex flex-wrap gap-3">
          <a
            href="https://chromewebstore.google.com/detail/lion-reader/mpjddkjjkckmclaifjfokjppfoenmlpl"
            target="_blank"
            rel="noopener noreferrer"
            className="ui-text-sm inline-flex items-center gap-2 rounded-lg border border-blue-300 bg-blue-50 px-4 py-2.5 font-medium text-blue-800 shadow-sm transition hover:border-blue-400 hover:bg-blue-100 hover:shadow dark:border-blue-700 dark:bg-blue-950 dark:text-blue-200 dark:hover:border-blue-600 dark:hover:bg-blue-900"
          >
            <ChromeIcon className="h-4 w-4" />
            Install Chrome Extension
          </a>
          <a
            href="https://addons.mozilla.org/en-US/firefox/addon/lion-reader/"
            target="_blank"
            rel="noopener noreferrer"
            className="ui-text-sm inline-flex items-center gap-2 rounded-lg border border-orange-300 bg-orange-50 px-4 py-2.5 font-medium text-orange-800 shadow-sm transition hover:border-orange-400 hover:bg-orange-100 hover:shadow dark:border-orange-700 dark:bg-orange-950 dark:text-orange-200 dark:hover:border-orange-600 dark:hover:bg-orange-900"
          >
            <FirefoxIcon className="h-4 w-4" />
            Install Firefox Extension
          </a>
        </div>
      </div>

      {/* Bookmarklet Section */}
      <CardSection>
        <h3 className="ui-text-sm text-body font-medium">Bookmarklet</h3>
        <p className="ui-text-sm text-muted mt-1">
          For other browsers, drag this button to your bookmarks bar, then click it on any page you
          want to save.
        </p>
        <a
          ref={bookmarkletRef}
          href="#"
          onClick={(e) => e.preventDefault()}
          draggable
          className="ui-text-sm border-warning-border bg-warning-subtle text-warning-subtle-foreground hover:border-warning hover:bg-warning-subtle mt-3 inline-flex items-center gap-2 rounded-lg border px-4 py-2.5 font-medium shadow-sm transition hover:shadow active:scale-95"
        >
          <BookmarkIcon className="h-4 w-4" />
          Save to Lion Reader
        </a>

        <button
          type="button"
          onClick={() => setShowCode(!showCode)}
          className="ui-text-sm text-body hover:text-body mt-3 flex min-h-11 items-center gap-2 font-medium transition-colors"
        >
          <ChevronRightIcon
            className={`h-4 w-4 transition-transform ${showCode ? "rotate-90" : ""}`}
          />
          {showCode ? "Hide bookmarklet code" : "Show bookmarklet code"}
        </button>

        {showCode && (
          <div className="mt-2">
            <p className="ui-text-sm text-muted mb-2">
              Or create a bookmark manually with this as its URL:
            </p>
            <CodeBlock code={bookmarkletHref} />
          </div>
        )}
      </CardSection>
    </SettingsSection>
  );
}
