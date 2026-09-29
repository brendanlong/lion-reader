/**
 * LocalPersistenceSettings Component
 *
 * Per-device toggle for keeping the entry store on this device between
 * visits. Hidden when the operator has disabled it or the browser can't store
 * it.
 */

"use client";

import { useState } from "react";
import { SettingsSection } from "@/components/settings/SettingsSection";
import { Switch } from "@/components/ui/switch";
import { useLocalPersistenceSetting } from "@/lib/hooks/useLocalPersistence";

export function LocalPersistenceSettings() {
  const { available, enabled, setEnabled } = useLocalPersistenceSetting();
  const [isChanging, setIsChanging] = useState(false);

  if (!available) return null;

  return (
    <SettingsSection title="This Device">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h3 id="local-persistence-label" className="ui-text-sm text-body font-medium">
            Keep entries on this device (beta)
          </h3>
          <p className="ui-text-sm text-muted mt-1">
            Lists you&apos;ve viewed show instantly on your next visit while they refresh. Stored
            entries are removed when you sign out or turn this off. Changing it reloads the page.
          </p>
        </div>
        <Switch
          checked={enabled}
          onChange={() => {
            setIsChanging(true);
            void setEnabled(!enabled);
          }}
          labelledBy="local-persistence-label"
          disabled={isChanging}
        />
      </div>
    </SettingsSection>
  );
}
