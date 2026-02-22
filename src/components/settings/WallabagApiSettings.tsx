/**
 * WallabagApiSettings Component
 *
 * Settings section for the Wallabag-compatible API.
 * Provides setup instructions, a QR code for auto-configuration,
 * and a deep link for configuring Wallabag mobile apps.
 */

"use client";

import { useMemo } from "react";
import { QRCodeSVG } from "qrcode.react";
import { trpc } from "@/lib/trpc/client";
import { MobileIcon } from "@/components/ui/icon-button";

export function WallabagApiSettings() {
  const userQuery = trpc.auth.me.useQuery();
  const email = userQuery.data?.user.email;

  const baseUrl = useMemo(() => {
    return (
      process.env.NEXT_PUBLIC_APP_URL ||
      (typeof window !== "undefined" ? window.location.origin : "")
    );
  }, []);

  const serverUrl = `${baseUrl}/api/wallabag`;

  // Build the wallabag:// deep link for auto-configuration.
  // Format: wallabag://username@server-host-and-path
  // The Android app splits on @ and pre-fills the server URL and username fields.
  const wallabagDeepLink = useMemo(() => {
    if (!email || !baseUrl) return null;
    try {
      const url = new URL(serverUrl);
      // Use host (includes port if non-standard) + pathname
      const serverPart = url.host + url.pathname;
      return `wallabag://${encodeURIComponent(email)}@${serverPart}`;
    } catch {
      return null;
    }
  }, [email, baseUrl, serverUrl]);

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

        {/* Quick Setup: QR Code + Deep Link */}
        {wallabagDeepLink && (
          <div className="mt-6 border-t border-zinc-200 pt-6 dark:border-zinc-700">
            <h3 className="ui-text-sm font-medium text-zinc-900 dark:text-zinc-100">Quick Setup</h3>
            <p className="ui-text-sm mt-1 text-zinc-600 dark:text-zinc-400">
              Scan this QR code with your phone or tap the button below to auto-configure the
              Wallabag Android app. You&apos;ll only need to enter your password.
            </p>

            <div className="mt-4 flex flex-col items-center gap-4 sm:flex-row sm:items-start">
              {/* QR Code */}
              <div className="rounded-lg border border-zinc-200 bg-white p-3 dark:border-zinc-700 dark:bg-white">
                <QRCodeSVG value={wallabagDeepLink} size={160} level="M" />
              </div>

              {/* Deep Link Button + Info */}
              <div className="flex flex-col gap-3">
                <a
                  href={wallabagDeepLink}
                  className="bg-accent hover:bg-accent-hover inline-flex items-center gap-2 rounded-md px-4 py-2 font-medium text-white transition-colors"
                >
                  <MobileIcon className="h-4 w-4" />
                  Open in Wallabag App
                </a>
                <p className="ui-text-xs max-w-xs text-zinc-400 dark:text-zinc-500">
                  The QR code and button pre-fill the server URL and your email address. Client ID
                  and secret are both{" "}
                  <code className="rounded bg-zinc-100 px-1 font-mono dark:bg-zinc-800">
                    wallabag
                  </code>
                  .
                </p>
              </div>
            </div>
          </div>
        )}

        {/* Manual Setup Instructions */}
        <div className="mt-6 border-t border-zinc-200 pt-6 dark:border-zinc-700">
          <h3 className="ui-text-sm font-medium text-zinc-900 dark:text-zinc-100">Manual Setup</h3>
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
              <strong className="text-zinc-900 dark:text-zinc-200">Username:</strong>{" "}
              {email ? (
                <code className="ui-text-xs rounded bg-zinc-100 px-1.5 py-0.5 font-mono dark:bg-zinc-800">
                  {email}
                </code>
              ) : (
                "Your Lion Reader email address"
              )}
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
