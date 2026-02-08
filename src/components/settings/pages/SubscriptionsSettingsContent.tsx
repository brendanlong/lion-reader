/**
 * Subscriptions Settings Content
 *
 * Page for managing subscription organization: tags and OPML import/export.
 */

"use client";

import { OpmlImportExport } from "@/components/settings/OpmlImportExport";
import { TagManagement } from "@/components/settings/TagManagement";

export default function SubscriptionsSettingsContent() {
  return (
    <div className="space-y-8">
      {/* Tags Section */}
      <TagManagement />

      {/* OPML Import/Export Section */}
      <OpmlImportExport />
    </div>
  );
}
