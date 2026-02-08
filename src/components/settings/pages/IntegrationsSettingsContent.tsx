/**
 * Integrations Settings Content
 *
 * Page for browser extensions, bookmarklets, Discord bot, AI integrations,
 * and API token management.
 */

"use client";

import {
  BookmarkletSettings,
  DiscordBotSettings,
  IntegrationsSettings,
} from "@/components/settings";
import ApiTokensSettingsContent from "./ApiTokensSettingsContent";

export default function IntegrationsSettingsContent() {
  return (
    <div className="space-y-8">
      {/* Save to Lion Reader (Firefox extension + bookmarklet) */}
      <BookmarkletSettings />

      {/* Discord Bot */}
      <DiscordBotSettings />

      {/* AI Integrations (MCP) */}
      <IntegrationsSettings />

      {/* API Tokens */}
      <ApiTokensSettingsContent />
    </div>
  );
}
