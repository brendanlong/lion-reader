/**
 * Reading Settings Content
 *
 * How reading behaves: when articles are marked read, and keyboard shortcuts.
 */

"use client";

import { MarkReadSettings } from "@/components/settings/MarkReadSettings";
import { KeyboardShortcutsSettings } from "@/components/settings/KeyboardShortcutsSettings";

export default function ReadingSettingsContent() {
  return (
    <div className="space-y-8">
      <MarkReadSettings />
      <KeyboardShortcutsSettings />
    </div>
  );
}
