/**
 * GoogleReaderApiSettings Component
 *
 * Settings section explaining the Google Reader-compatible API.
 * This is informational only — no configuration needed.
 */

"use client";

import { useMemo } from "react";
import { SettingsSection } from "@/components/settings/SettingsSection";
import { CardSection } from "@/components/ui/card";
import { CopyButton } from "@/components/ui/copy-button";
import { InlineCode } from "@/components/ui/inline-code";
import { NoteBox } from "@/components/ui/note-box";
import { TextLink } from "@/components/ui/text-link";

export function GoogleReaderApiSettings() {
  const baseUrl = useMemo(() => {
    return (
      process.env.NEXT_PUBLIC_APP_URL ||
      (typeof window !== "undefined" ? window.location.origin : "")
    );
  }, []);

  const apiBase = `${baseUrl}/api/greader.php/reader/api/0`;

  return (
    <SettingsSection
      title="Google Reader API"
      description={
        <>
          Lion Reader exposes a{" "}
          <TextLink href="https://feedhq.readthedocs.io/en/latest/api/" external>
            Google Reader-compatible API
          </TextLink>{" "}
          so you can use third-party RSS reader apps to sync with your Lion Reader account.
        </>
      }
    >
      {/* Supported Clients */}
      <div className="mt-6">
        <h3 className="ui-text-sm text-strong font-medium">Compatible Apps</h3>
        <p className="ui-text-sm text-muted mt-1">
          Any app that supports the Google Reader API should work, including:
        </p>
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
        <h3 className="ui-text-sm text-strong font-medium">Setup</h3>
        <p className="ui-text-sm text-muted mt-1">
          In your app&apos;s account settings, choose &ldquo;FreshRSS&rdquo; as the service type,
          then enter:
        </p>
        <ul className="ui-text-sm text-muted mt-3 space-y-2">
          <li>
            <strong className="text-emphasis">Server URL:</strong>{" "}
            <InlineCode>{baseUrl}/api/greader.php</InlineCode>
            <CopyButton
              value={`${baseUrl}/api/greader.php`}
              className="ml-2 px-1.5 py-0.5"
              title="Copy server URL"
            />
          </li>
          <li>
            <strong className="text-emphasis">Email:</strong> Your Lion Reader email address
          </li>
          <li>
            <strong className="text-emphasis">Password:</strong> Your Lion Reader password
          </li>
        </ul>
      </CardSection>

      {/* Note */}
      <NoteBox className="mt-6">
        <p className="ui-text-sm text-muted">
          The API uses your regular Lion Reader credentials for authentication. All your
          subscriptions, tags, read state, and starred articles sync automatically.
        </p>
      </NoteBox>

      {/* API base URL note */}
      {baseUrl && <p className="ui-text-xs text-faint mt-4">API endpoint: {apiBase}</p>}
    </SettingsSection>
  );
}
