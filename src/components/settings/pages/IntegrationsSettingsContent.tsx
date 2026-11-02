/**
 * Integrations Settings Content
 *
 * Page for the ways to save articles (browser extensions, bookmarklet, Wallabag
 * apps, the Discord bot), then other apps that use the account (Google Reader
 * clients, AI assistants).
 */

"use client";

import { BookmarkletSettings } from "@/components/settings/BookmarkletSettings";
import { DiscordBotSettings } from "@/components/settings/DiscordBotSettings";
import { GoogleReaderApiSettings } from "@/components/settings/GoogleReaderApiSettings";
import { WallabagApiSettings } from "@/components/settings/WallabagApiSettings";
import { IntegrationsSettings } from "@/components/settings/IntegrationsSettings";

export default function IntegrationsSettingsContent() {
  return (
    <div className="space-y-8">
      {/* Ways to save articles */}
      <BookmarkletSettings />
      <WallabagApiSettings />
      <DiscordBotSettings />

      {/* Other apps using your account */}
      <GoogleReaderApiSettings />
      <IntegrationsSettings />
    </div>
  );
}
