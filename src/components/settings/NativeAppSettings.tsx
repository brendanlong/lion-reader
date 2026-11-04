import { SettingsSection } from "@/components/settings/SettingsSection";
import { TextLink } from "@/components/ui/text-link";
import { CONTACT_EMAIL, DISCORD_SERVER_URL } from "@/lib/contact";

export function NativeAppSettings() {
  return (
    <SettingsSection id="native-app" title="Lion Reader App">
      <p className="ui-text-sm text-muted">
        We have a native Android app in beta. If you&apos;d like to try it, email{" "}
        <TextLink href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</TextLink> or ask in our{" "}
        <TextLink href={DISCORD_SERVER_URL} external>
          Discord server
        </TextLink>
        .
      </p>
    </SettingsSection>
  );
}
