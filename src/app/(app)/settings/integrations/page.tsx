/**
 * Integrations Settings Page
 *
 * Page for browser extensions, bookmarklets, Discord bot, and AI integrations.
 */

import {
  BookmarkletSettings,
  DiscordBotSettings,
  IntegrationsSettings,
} from "@/components/settings";

export default function IntegrationsPage() {
  return (
    <div className="space-y-8">
      {/* Save to Lion Reader (Firefox extension + bookmarklet) */}
      <BookmarkletSettings />

      {/* Discord Bot */}
      <DiscordBotSettings />

      {/* AI Integrations (MCP) */}
      <IntegrationsSettings />
    </div>
  );
}
