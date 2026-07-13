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
import { InfoCircleIcon } from "@/components/ui/icon-button";
import { Kbd } from "@/components/ui/kbd";

export function KeyboardShortcutsSettings() {
  const { enabled, setEnabled, openShortcutsModal } = useKeyboardShortcutsContext();

  return (
    <SettingsSection title="Keyboard Shortcuts">
      {/* Enable/Disable Toggle */}
      <div className="flex items-center justify-between">
        <div>
          <h3 className="ui-text-sm text-strong font-medium">Enable keyboard shortcuts</h3>
          <p className="ui-text-sm text-muted mt-1">
            Use keyboard shortcuts to navigate entries and perform actions quickly.
          </p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          onClick={() => setEnabled(!enabled)}
          className={`focus:ring-focus focus:ring-offset-surface relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:ring-2 focus:ring-offset-2 focus:outline-none ${
            enabled ? "bg-primary-solid" : "bg-fill-muted"
          }`}
        >
          <span
            aria-hidden="true"
            className={`bg-surface pointer-events-none inline-block h-5 w-5 transform rounded-full shadow ring-0 transition duration-200 ease-in-out ${
              enabled ? "translate-x-5" : "translate-x-0"
            }`}
          />
        </button>
      </div>

      {/* View Shortcuts Button */}
      <CardSection>
        <button
          onClick={openShortcutsModal}
          className="ui-text-sm text-body hover:text-strong inline-flex items-center gap-2 font-medium transition-colors"
        >
          <InfoCircleIcon className="h-4 w-4" />
          View all keyboard shortcuts
          {enabled && <Kbd className="ml-1">?</Kbd>}
        </button>
      </CardSection>
    </SettingsSection>
  );
}
