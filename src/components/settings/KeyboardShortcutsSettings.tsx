/**
 * KeyboardShortcutsSettings Component
 *
 * Settings section for keyboard shortcuts configuration.
 * Allows users to enable/disable keyboard shortcuts and view the shortcuts modal.
 */

"use client";

import { useKeyboardShortcutsContext } from "@/components/keyboard/KeyboardShortcutsProvider";
import { SettingsSection } from "@/components/settings/SettingsSection";
import { CardSection } from "@/components/ui/card";
import { InfoCircleIcon } from "@/components/ui/icons";
import { Kbd } from "@/components/ui/kbd";
import { Switch } from "@/components/ui/switch";

export function KeyboardShortcutsSettings() {
  const { enabled, setEnabled, openShortcutsModal } = useKeyboardShortcutsContext();

  return (
    <SettingsSection title="Keyboard Shortcuts">
      {/* Enable/Disable Toggle */}
      <div className="flex items-center justify-between">
        <div>
          <h3 id="keyboard-shortcuts-label" className="ui-text-sm text-body font-medium">
            Enable keyboard shortcuts
          </h3>
          <p className="ui-text-sm text-muted mt-1">
            Use keyboard shortcuts to navigate entries and perform actions quickly.
          </p>
        </div>
        <Switch
          checked={enabled}
          onChange={() => setEnabled(!enabled)}
          labelledBy="keyboard-shortcuts-label"
        />
      </div>

      {/* View Shortcuts Button */}
      <CardSection>
        <button
          onClick={openShortcutsModal}
          className="ui-text-sm text-body hover:text-body inline-flex items-center gap-2 font-medium transition-colors"
        >
          <InfoCircleIcon className="h-4 w-4" />
          View all keyboard shortcuts
          {enabled && <Kbd className="ml-1">?</Kbd>}
        </button>
      </CardSection>
    </SettingsSection>
  );
}
