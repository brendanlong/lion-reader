/**
 * Feed Health Settings Content
 *
 * Combined page for monitoring feed status: broken feeds with errors
 * and overall feed statistics.
 */

"use client";

import BrokenFeedsSettingsContent from "./BrokenFeedsSettingsContent";
import FeedStatsSettingsContent from "./FeedStatsSettingsContent";

export default function FeedHealthSettingsContent() {
  return (
    <div className="space-y-12">
      {/* Broken Feeds - actionable issues first */}
      <BrokenFeedsSettingsContent />

      {/* Feed Statistics - overview of all feeds */}
      <FeedStatsSettingsContent />
    </div>
  );
}
