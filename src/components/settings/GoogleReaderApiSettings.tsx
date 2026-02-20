/**
 * GoogleReaderApiSettings Component
 *
 * Settings section explaining the Google Reader-compatible API.
 * This is informational only — no configuration needed.
 */

"use client";

import { useMemo } from "react";

export function GoogleReaderApiSettings() {
  const baseUrl = useMemo(() => {
    return (
      process.env.NEXT_PUBLIC_APP_URL ||
      (typeof window !== "undefined" ? window.location.origin : "")
    );
  }, []);

  const apiBase = `${baseUrl}/reader/api/0`;

  return (
    <section>
      <h2 className="ui-text-lg mb-4 font-semibold text-zinc-900 dark:text-zinc-50">
        Google Reader API
      </h2>
      <div className="rounded-lg border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-900">
        {/* Description */}
        <p className="ui-text-sm text-zinc-600 dark:text-zinc-400">
          Lion Reader exposes a{" "}
          <a
            href="https://feedhq.readthedocs.io/en/latest/api/"
            target="_blank"
            rel="noopener noreferrer"
            className="font-medium text-blue-600 hover:text-blue-700 dark:text-blue-400 dark:hover:text-blue-300"
          >
            Google Reader-compatible API
          </a>{" "}
          so you can use third-party RSS reader apps to sync with your Lion Reader account.
        </p>

        {/* Supported Clients */}
        <div className="mt-6">
          <h3 className="ui-text-sm font-medium text-zinc-900 dark:text-zinc-100">
            Compatible Apps
          </h3>
          <p className="ui-text-sm mt-1 text-zinc-600 dark:text-zinc-400">
            Any app that supports the Google Reader API should work, including:
          </p>
          <ul className="ui-text-sm mt-2 list-inside list-disc space-y-1 text-zinc-600 dark:text-zinc-400">
            <li>
              <strong className="text-zinc-900 dark:text-zinc-200">Reeder</strong> (iOS / macOS)
            </li>
            <li>
              <strong className="text-zinc-900 dark:text-zinc-200">NetNewsWire</strong> (iOS /
              macOS)
            </li>
            <li>
              <strong className="text-zinc-900 dark:text-zinc-200">FeedMe</strong> (Android)
            </li>
            <li>
              <strong className="text-zinc-900 dark:text-zinc-200">Read You</strong> (Android)
            </li>
            <li>
              <strong className="text-zinc-900 dark:text-zinc-200">NewsFlash</strong> (Linux)
            </li>
          </ul>
        </div>

        {/* Setup Instructions */}
        <div className="mt-6 border-t border-zinc-200 pt-6 dark:border-zinc-700">
          <h3 className="ui-text-sm font-medium text-zinc-900 dark:text-zinc-100">Setup</h3>
          <p className="ui-text-sm mt-1 text-zinc-600 dark:text-zinc-400">
            In your app&apos;s account settings, choose &ldquo;Google Reader&rdquo; or &ldquo;Google
            Reader API&rdquo; as the service type, then enter:
          </p>
          <ul className="ui-text-sm mt-3 space-y-2 text-zinc-600 dark:text-zinc-400">
            <li>
              <strong className="text-zinc-900 dark:text-zinc-200">Server URL:</strong>{" "}
              <code className="ui-text-xs rounded bg-zinc-100 px-1.5 py-0.5 font-mono dark:bg-zinc-800">
                {baseUrl}
              </code>
            </li>
            <li>
              <strong className="text-zinc-900 dark:text-zinc-200">Email:</strong> Your Lion Reader
              email address
            </li>
            <li>
              <strong className="text-zinc-900 dark:text-zinc-200">Password:</strong> Your Lion
              Reader password
            </li>
          </ul>
        </div>

        {/* Note */}
        <div className="mt-6 rounded-md border border-zinc-200 bg-zinc-50 p-4 dark:border-zinc-700 dark:bg-zinc-800/50">
          <p className="ui-text-sm text-zinc-600 dark:text-zinc-400">
            The API uses your regular Lion Reader credentials for authentication. All your
            subscriptions, tags, read state, and starred articles sync automatically.
          </p>
        </div>

        {/* API base URL note */}
        {baseUrl && (
          <p className="ui-text-xs mt-4 text-zinc-400 dark:text-zinc-500">
            API endpoint: {apiBase}
          </p>
        )}
      </div>
    </section>
  );
}
