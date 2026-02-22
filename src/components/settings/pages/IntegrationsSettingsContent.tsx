/**
 * Integrations Settings Content
 *
 * Page for browser extensions, bookmarklets, Discord bot, AI integrations,
 * and API token management.
 */

"use client";

import { BookmarkletSettings } from "@/components/settings/BookmarkletSettings";
import { DiscordBotSettings } from "@/components/settings/DiscordBotSettings";
import { GoogleReaderApiSettings } from "@/components/settings/GoogleReaderApiSettings";
import { WallabagApiSettings } from "@/components/settings/WallabagApiSettings";
import { IntegrationsSettings } from "@/components/settings/IntegrationsSettings";
import ApiTokensSettingsContent from "./ApiTokensSettingsContent";

export default function IntegrationsSettingsContent() {
  return (
    <div className="space-y-8">
      {/* Save to Lion Reader (Firefox extension + bookmarklet) */}
      <BookmarkletSettings />

      {/* Discord Bot */}
      <DiscordBotSettings />

      {/* Google Reader API (mobile/desktop client sync) */}
      <GoogleReaderApiSettings />

      {/* Wallabag API (save articles via mobile app) */}
      <WallabagApiSettings />

      {/* AI Integrations (MCP) */}
      <IntegrationsSettings />

      {/* API Tokens */}
      <ApiTokensSettingsContent />
    </div>
  );
}
