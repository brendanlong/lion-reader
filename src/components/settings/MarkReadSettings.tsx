"use client";

import { OptionGroup } from "@/components/settings/OptionGroup";
import { SettingsSection } from "@/components/settings/SettingsSection";
import { useMarkReadOn, type MarkReadOn } from "@/lib/hooks/useMarkReadOn";

const MARK_READ_ON_OPTIONS: { value: MarkReadOn; label: string; description: string }[] = [
  {
    value: "opened",
    label: "Opened",
    description: "As soon as you open them.",
  },
  {
    value: "finished",
    label: "Finished",
    description: "Once you scroll to the end, or narration finishes reading them.",
  },
  { value: "never", label: "Never", description: "Only when you mark them read yourself." },
];

export function MarkReadSettings() {
  const [markReadOn, setMarkReadOn] = useMarkReadOn();

  return (
    <SettingsSection title="Mark as Read" description="Applies to this browser only.">
      <OptionGroup
        label="Mark articles read when"
        description={
          MARK_READ_ON_OPTIONS.find((option) => option.value === markReadOn)?.description
        }
        value={markReadOn}
        options={MARK_READ_ON_OPTIONS}
        onChange={setMarkReadOn}
      />
    </SettingsSection>
  );
}
