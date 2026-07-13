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
import { SettingsSection } from "@/components/settings/SettingsSection";
import { CardSection } from "@/components/ui/card";
import { CopyButton } from "@/components/ui/copy-button";
import { MobileIcon } from "@/components/ui/icon-button";
import { InlineCode } from "@/components/ui/inline-code";
import { NoteBox } from "@/components/ui/note-box";
import { TextLink } from "@/components/ui/text-link";

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
  // Format: wallabag://username@server-url
  // The Android app splits on @ to get [username, server] and pre-fills those fields.
  // Since Lion Reader uses email addresses as usernames (containing @), we encode
  // the @ as %40 so the split produces exactly 2 parts. The user will see the
  // percent-encoded email in the username field and may need to fix it manually.
  // We include https:// in the server part so the app can connect without the user
  // needing to add it.
  const wallabagDeepLink = useMemo(() => {
    if (!email || !baseUrl) return null;
    const encodedEmail = email.replace(/@/g, "%40");
    return `wallabag://${encodedEmail}@${serverUrl}`;
  }, [email, baseUrl, serverUrl]);

  return (
    <SettingsSection
      title="Wallabag API (Save Articles)"
      description={
        <>
          Lion Reader exposes a{" "}
          <TextLink href="https://doc.wallabag.org/developer/api/methods/" external>
            Wallabag-compatible API
          </TextLink>{" "}
          so you can use the Wallabag app on your phone or tablet to save articles directly to Lion
          Reader.
        </>
      }
    >
      {/* Supported Clients */}
      <div className="mt-6">
        <h3 className="ui-text-sm text-strong font-medium">Compatible Apps</h3>
        <ul className="ui-text-sm text-muted mt-2 list-inside list-disc space-y-1">
          <li>
            <TextLink
              href="https://play.google.com/store/apps/details?id=fr.gaulupeau.apps.InThePoche"
              external
            >
              wallabag
            </TextLink>{" "}
            (Android)
          </li>
          <li>
            <TextLink href="https://apps.apple.com/app/wallabag-2-official/id1170800946" external>
              wallabag 2
            </TextLink>{" "}
            (iOS)
          </li>
        </ul>
      </div>

      {/* Quick Setup: QR Code + Deep Link */}
      {wallabagDeepLink && (
        <CardSection>
          <h3 className="ui-text-sm text-strong font-medium">Quick Setup</h3>
          <p className="ui-text-sm text-muted mt-1">
            Scan this QR code with your phone or tap the button below to auto-configure the Wallabag
            Android app. You&apos;ll need to enter your password, and fix the username if the{" "}
            <InlineCode>@</InlineCode> shows as <InlineCode>%40</InlineCode>.
          </p>

          <div className="mt-4 flex flex-col items-center gap-4 sm:flex-row sm:items-start">
            {/* QR Code */}
            <div className="border-edge-strong rounded-lg border bg-white p-3 dark:bg-white">
              <QRCodeSVG value={wallabagDeepLink} size={160} level="M" />
            </div>

            {/* Deep Link Button + Info */}
            <div className="flex flex-col gap-3">
              <a
                href={wallabagDeepLink}
                className="btn-primary inline-flex items-center gap-2 rounded-md px-4 py-2 font-medium"
              >
                <MobileIcon className="h-4 w-4" />
                Open in Wallabag App
              </a>
              <p className="ui-text-xs text-faint max-w-xs">
                The QR code and button pre-fill the server URL and your email address. Client ID and
                secret are both <InlineCode>wallabag</InlineCode>.
              </p>
            </div>
          </div>
        </CardSection>
      )}

      {/* Manual Setup Instructions */}
      <CardSection>
        <h3 className="ui-text-sm text-strong font-medium">Manual Setup</h3>
        <p className="ui-text-sm text-muted mt-1">
          In the Wallabag app, go to Settings and enter the following:
        </p>
        <ul className="ui-text-sm text-muted mt-3 space-y-2">
          <li>
            <strong className="text-emphasis">Server URL:</strong>{" "}
            <InlineCode>{serverUrl}</InlineCode>
            <CopyButton value={serverUrl} className="ml-2 px-1.5 py-0.5" title="Copy server URL" />
          </li>
          <li>
            <strong className="text-emphasis">Client ID:</strong> <InlineCode>wallabag</InlineCode>
            <CopyButton value="wallabag" className="ml-2 px-1.5 py-0.5" title="Copy client ID" />
          </li>
          <li>
            <strong className="text-emphasis">Client Secret:</strong>{" "}
            <InlineCode>wallabag</InlineCode>
            <CopyButton
              value="wallabag"
              className="ml-2 px-1.5 py-0.5"
              title="Copy client secret"
            />
          </li>
          <li>
            <strong className="text-emphasis">Username:</strong>{" "}
            {email ? (
              <>
                <InlineCode>{email}</InlineCode>
                <CopyButton value={email} className="ml-2 px-1.5 py-0.5" title="Copy username" />
              </>
            ) : (
              "Your Lion Reader email address"
            )}
          </li>
          <li>
            <strong className="text-emphasis">Password:</strong> Your Lion Reader password
          </li>
        </ul>
      </CardSection>

      {/* How it works */}
      <NoteBox className="mt-6">
        <p className="ui-text-sm text-muted">
          When you share a URL to the Wallabag app, it will save it to your Lion Reader account as a
          saved article. You can also view, archive, star, and delete saved articles from the app.
        </p>
      </NoteBox>

      {/* API base URL note */}
      {baseUrl && <p className="ui-text-xs text-faint mt-4">API endpoint: {serverUrl}</p>}
    </SettingsSection>
  );
}
