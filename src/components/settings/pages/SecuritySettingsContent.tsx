/**
 * Security Settings Content
 *
 * Everything that can access the account: signed-in devices, authorized OAuth
 * apps, and API tokens.
 */

"use client";

import SessionsSettingsContent from "./SessionsSettingsContent";
import ConnectedAppsSettingsContent from "./ConnectedAppsSettingsContent";
import ApiTokensSettingsContent from "./ApiTokensSettingsContent";

export default function SecuritySettingsContent() {
  return (
    <div className="space-y-12">
      <SessionsSettingsContent />
      <ConnectedAppsSettingsContent />
      <ApiTokensSettingsContent />
    </div>
  );
}
