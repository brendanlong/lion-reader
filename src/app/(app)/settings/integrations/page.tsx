/**
 * Integrations Settings Page
 *
 * Page for browser extensions, bookmarklets, and AI integrations.
 */

import { BookmarkletSettings, IntegrationsSettings } from "@/components/settings";

export default function IntegrationsPage() {
  return (
    <div className="space-y-8">
      {/* Save to Lion Reader (Firefox extension + bookmarklet) */}
      <BookmarkletSettings />

      {/* AI Integrations (MCP) */}
      <IntegrationsSettings />
    </div>
  );
}
