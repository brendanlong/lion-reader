/**
 * GoogleReaderApiSettings Component
 *
 * Settings section explaining the Google Reader-compatible API.
 */

"use client";

import { useAppBaseUrl } from "@/lib/hooks/useAppBaseUrl";
import { SettingsSection } from "@/components/settings/SettingsSection";
import { CardSection } from "@/components/ui/card";
import { CopyButton } from "@/components/ui/copy-button";
import { InlineCode } from "@/components/ui/inline-code";
import { TextLink } from "@/components/ui/text-link";
import { ClientLink } from "@/components/ui/client-link";

export function GoogleReaderApiSettings() {
  const baseUrl = useAppBaseUrl();

  return (
    <SettingsSection
      title="Google Reader API"
      description={
        <>
          Use another RSS app with your Lion Reader account. Subscriptions, tags, read state and
          stars stay in sync. Any app that supports the{" "}
          <TextLink href="https://feedhq.readthedocs.io/en/latest/api/" external>
            Google Reader API
          </TextLink>{" "}
          should work.
        </>
      }
    >
      {/* Supported Clients */}
      <div>
        <h3 className="ui-text-sm text-body font-medium">Compatible Apps</h3>
        <ul className="ui-text-sm text-muted mt-2 list-inside list-disc space-y-1">
          <li>
            <TextLink href="https://reederapp.com/classic/" external>
              Reeder Classic
            </TextLink>{" "}
            (iOS / macOS)
          </li>
          <li>
            <TextLink href="https://netnewswire.com/" external>
              NetNewsWire
            </TextLink>{" "}
            (iOS / macOS)
          </li>
          <li>
            <TextLink
              href="https://play.google.com/store/apps/details?id=allen.town.focus.reader"
              external
            >
              FocusReader
            </TextLink>{" "}
            (Android)
          </li>
          <li>
            <TextLink href="https://f-droid.org/packages/me.ash.reader" external>
              Read You
            </TextLink>{" "}
            (Android)
          </li>
          <li>
            <TextLink href="https://flathub.org/apps/io.gitlab.news_flash.NewsFlash" external>
              NewsFlash
            </TextLink>{" "}
            (Linux)
          </li>
        </ul>
      </div>

      {/* Setup Instructions */}
      <CardSection>
        <h3 className="ui-text-sm text-body font-medium">Setup</h3>
        <p className="ui-text-sm text-muted mt-1">
          In your app, add a &ldquo;FreshRSS&rdquo; account and enter:
        </p>
        <ul className="ui-text-sm text-muted mt-3 space-y-2">
          <li>
            <strong className="text-body">Server URL:</strong>{" "}
            <InlineCode>{baseUrl}/api/greader.php</InlineCode>
            <CopyButton
              value={`${baseUrl}/api/greader.php`}
              className="ml-2 px-1.5 py-0.5"
              title="Copy server URL"
            />
          </li>
          <li>
            <strong className="text-body">Email:</strong> Your Lion Reader email address
          </li>
          <li>
            <strong className="text-body">Password:</strong> Your Lion Reader password
          </li>
        </ul>
        <p className="ui-text-sm text-muted mt-3">
          Signed up with Google, Apple or Discord? Set a password under{" "}
          <ClientLink href="/settings" className="text-accent hover:text-accent-hover font-medium">
            Account
          </ClientLink>{" "}
          first.
        </p>
      </CardSection>
    </SettingsSection>
  );
}
