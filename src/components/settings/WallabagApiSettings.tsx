/**
 * WallabagApiSettings Component
 *
 * Settings section for the Wallabag-compatible API.
 * Provides setup instructions, a QR code for auto-configuration,
 * a deep link for configuring Wallabag mobile apps, and a way to sign
 * them all out.
 */

"use client";

import { useMemo } from "react";
import { toast } from "sonner";
import { useAppBaseUrl } from "@/lib/hooks/useAppBaseUrl";
import { QRCodeSVG } from "qrcode.react";
import { trpc } from "@/lib/trpc/client";
import { SettingsSection } from "@/components/settings/SettingsSection";
import { Button } from "@/components/ui/button";
import { CardSection } from "@/components/ui/card";
import { CopyButton } from "@/components/ui/copy-button";
import { MobileIcon } from "@/components/ui/icons";
import { InlineCode } from "@/components/ui/inline-code";
import { TextLink } from "@/components/ui/text-link";

export function WallabagApiSettings() {
  const userQuery = trpc.auth.me.useQuery();
  const email = userQuery.data?.user.email;

  const baseUrl = useAppBaseUrl();

  const revokeMutation = trpc.oauthGrants.revokeWallabag.useMutation({
    onSuccess: () => {
      toast.success("Signed out all Wallabag apps");
    },
    onError: (error) => {
      toast.error("Failed to sign out Wallabag apps", { description: error.message });
    },
  });

  const handleRevoke = () => {
    if (
      confirm(
        "Sign out every Wallabag app connected to your account? Each one will need your password to reconnect."
      )
    ) {
      revokeMutation.mutate();
    }
  };

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
      title="Wallabag API"
      description={
        <>
          Save articles from your phone by sharing them to a{" "}
          <TextLink href="https://doc.wallabag.org/developer/api/methods/" external>
            Wallabag
          </TextLink>{" "}
          app, which can also read, star, archive and delete your saved articles.
        </>
      }
    >
      {/* Supported Clients */}
      <div>
        <h3 className="ui-text-sm text-body font-medium">Compatible Apps</h3>
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
          <h3 className="ui-text-sm text-body font-medium">Quick Setup</h3>
          <p className="ui-text-sm text-muted mt-1">
            Scan the code or tap the button to fill in the Android app&apos;s server and username.
            Then enter your password, and fix the username if its <InlineCode>@</InlineCode> shows
            as <InlineCode>%40</InlineCode>.
          </p>

          <div className="mt-4 flex flex-col items-center gap-4 sm:flex-row sm:items-start">
            {/* QR Code */}
            <div className="border-edge-strong rounded-lg border bg-white p-3">
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
              <p className="ui-text-xs text-muted max-w-xs">
                Client ID and secret are both <InlineCode>wallabag</InlineCode>.
              </p>
            </div>
          </div>
        </CardSection>
      )}

      {/* Manual Setup Instructions */}
      <CardSection>
        <h3 className="ui-text-sm text-body font-medium">Manual Setup</h3>
        <p className="ui-text-sm text-muted mt-1">In the Wallabag app&apos;s settings, enter:</p>
        <ul className="ui-text-sm text-muted mt-3 space-y-2">
          <li>
            <strong className="text-body">Server URL:</strong> <InlineCode>{serverUrl}</InlineCode>
            <CopyButton value={serverUrl} className="ml-2 px-1.5 py-0.5" title="Copy server URL" />
          </li>
          <li>
            <strong className="text-body">Client ID:</strong> <InlineCode>wallabag</InlineCode>
            <CopyButton value="wallabag" className="ml-2 px-1.5 py-0.5" title="Copy client ID" />
          </li>
          <li>
            <strong className="text-body">Client Secret:</strong> <InlineCode>wallabag</InlineCode>
            <CopyButton
              value="wallabag"
              className="ml-2 px-1.5 py-0.5"
              title="Copy client secret"
            />
          </li>
          <li>
            <strong className="text-body">Username:</strong>{" "}
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
            <strong className="text-body">Password:</strong> Your Lion Reader password
          </li>
        </ul>
      </CardSection>

      <CardSection>
        <h3 className="ui-text-sm text-body font-medium">Sign Out Apps</h3>
        <p className="ui-text-sm text-muted mt-1">
          Disconnect every Wallabag app signed in to your account. Changing your password also does
          this.
        </p>
        <Button
          variant="ghost"
          size="sm"
          onClick={handleRevoke}
          disabled={revokeMutation.isPending}
          className="text-danger hover:bg-danger-subtle hover:text-danger-hover mt-3"
        >
          Sign out all Wallabag apps
        </Button>
      </CardSection>
    </SettingsSection>
  );
}
