/**
 * WallabagApiSettings Component
 *
 * Settings section explaining the Wallabag-compatible API.
 * This is informational only -- provides setup instructions for
 * configuring Wallabag mobile apps to save articles to Lion Reader.
 */

"use client";

import { useMemo } from "react";

export function WallabagApiSettings() {
  const baseUrl = useMemo(() => {
    return (
      process.env.NEXT_PUBLIC_APP_URL ||
      (typeof window !== "undefined" ? window.location.origin : "")
    );
  }, []);

  const serverUrl = `${baseUrl}/api/wallabag`;

  return (
    <section>
      <h2 className="ui-text-lg mb-4 font-semibold text-zinc-900 dark:text-zinc-50">
        Wallabag API (Save Articles)
      </h2>
      <div className="rounded-lg border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-900">
        {/* Description */}
        <p className="ui-text-sm text-zinc-600 dark:text-zinc-400">
          Lion Reader exposes a{" "}
          <a
            href="https://doc.wallabag.org/developer/api/methods/"
            target="_blank"
            rel="noopener noreferrer"
            className="text-accent hover:text-accent-hover font-medium"
          >
            Wallabag-compatible API
          </a>{" "}
          so you can use the Wallabag app on your phone or tablet to save articles directly to Lion
          Reader.
        </p>

        {/* Supported Clients */}
        <div className="mt-6">
          <h3 className="ui-text-sm font-medium text-zinc-900 dark:text-zinc-100">
            Compatible Apps
          </h3>
          <ul className="ui-text-sm mt-2 list-inside list-disc space-y-1 text-zinc-600 dark:text-zinc-400">
            <li>
              <a
                href="https://play.google.com/store/apps/details?id=fr.gaulupeau.apps.InThePoche"
                target="_blank"
                rel="noopener noreferrer"
                className="text-accent hover:text-accent-hover font-medium"
              >
                wallabag
              </a>{" "}
              (Android)
            </li>
            <li>
              <a
                href="https://apps.apple.com/app/wallabag-2-official/id1170800946"
                target="_blank"
                rel="noopener noreferrer"
                className="text-accent hover:text-accent-hover font-medium"
              >
                wallabag 2
              </a>{" "}
              (iOS)
            </li>
          </ul>
        </div>

        {/* Setup Instructions */}
        <div className="mt-6 border-t border-zinc-200 pt-6 dark:border-zinc-700">
          <h3 className="ui-text-sm font-medium text-zinc-900 dark:text-zinc-100">Setup</h3>
          <p className="ui-text-sm mt-1 text-zinc-600 dark:text-zinc-400">
            In the Wallabag app, go to Settings and enter the following:
          </p>
          <ul className="ui-text-sm mt-3 space-y-2 text-zinc-600 dark:text-zinc-400">
            <li>
              <strong className="text-zinc-900 dark:text-zinc-200">Server URL:</strong>{" "}
              <code className="ui-text-xs rounded bg-zinc-100 px-1.5 py-0.5 font-mono dark:bg-zinc-800">
                {serverUrl}
              </code>
            </li>
            <li>
              <strong className="text-zinc-900 dark:text-zinc-200">Client ID:</strong>{" "}
              <code className="ui-text-xs rounded bg-zinc-100 px-1.5 py-0.5 font-mono dark:bg-zinc-800">
                wallabag
              </code>
            </li>
            <li>
              <strong className="text-zinc-900 dark:text-zinc-200">Client Secret:</strong>{" "}
              <code className="ui-text-xs rounded bg-zinc-100 px-1.5 py-0.5 font-mono dark:bg-zinc-800">
                wallabag
              </code>
            </li>
            <li>
              <strong className="text-zinc-900 dark:text-zinc-200">Username:</strong> Your Lion
              Reader email address
            </li>
            <li>
              <strong className="text-zinc-900 dark:text-zinc-200">Password:</strong> Your Lion
              Reader password
            </li>
          </ul>
        </div>

        {/* How it works */}
        <div className="mt-6 rounded-md border border-zinc-200 bg-zinc-50 p-4 dark:border-zinc-700 dark:bg-zinc-800/50">
          <p className="ui-text-sm text-zinc-600 dark:text-zinc-400">
            When you share a URL to the Wallabag app, it will save it to your Lion Reader account as
            a saved article. You can also view, archive, star, and delete saved articles from the
            app.
          </p>
        </div>

        {/* API base URL note */}
        {baseUrl && (
          <p className="ui-text-xs mt-4 text-zinc-400 dark:text-zinc-500">
            API endpoint: {serverUrl}
          </p>
        )}
      </div>
    </section>
  );
}
