/**
 * AppearanceSettings Component
 *
 * Settings UI for appearance preferences including:
 * - Theme mode (system/light/dark) - powered by next-themes
 * - Text size for entry content
 * - Text justification for entry content
 * - Font family for entry content
 */

"use client";

import { useTheme } from "next-themes";
import { SettingsSection } from "@/components/settings/SettingsSection";
import { useAppearance, useEntryTextStyles } from "@/lib/appearance/AppearanceProvider";
import type { TextSize, TextJustification, FontFamily } from "@/lib/appearance/settings";

interface OptionButtonProps<T extends string> {
  value: T;
  selected: boolean;
  onClick: () => void;
  children: React.ReactNode;
}

function OptionButton<T extends string>({ selected, onClick, children }: OptionButtonProps<T>) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`ui-text-sm rounded-md px-4 py-2 font-medium transition-colors ${
        selected
          ? "bg-primary-solid text-primary-solid-foreground"
          : "bg-surface-muted text-body hover:bg-zinc-200 dark:hover:bg-zinc-700"
      }`}
    >
      {children}
    </button>
  );
}

interface OptionGroupProps<T extends string> {
  label: string;
  description?: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
}

function OptionGroup<T extends string>({
  label,
  description,
  value,
  options,
  onChange,
}: OptionGroupProps<T>) {
  return (
    <div>
      <label className="ui-text-sm text-strong block font-medium">{label}</label>
      <div className="mt-2 flex flex-wrap gap-2">
        {options.map((option) => (
          <OptionButton
            key={option.value}
            value={option.value}
            selected={value === option.value}
            onClick={() => onChange(option.value)}
          >
            {option.label}
          </OptionButton>
        ))}
      </div>
      {description && <p className="ui-text-sm text-subtle mt-1">{description}</p>}
    </div>
  );
}

/** Theme options for next-themes (uses "system" instead of "auto") */
const THEME_OPTIONS: { value: string; label: string }[] = [
  { value: "system", label: "Auto" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

const TEXT_SIZE_OPTIONS: { value: TextSize; label: string }[] = [
  { value: "small", label: "Small" },
  { value: "medium", label: "Medium" },
  { value: "large", label: "Large" },
  { value: "x-large", label: "Extra Large" },
];

const JUSTIFICATION_OPTIONS: { value: TextJustification; label: string }[] = [
  { value: "left", label: "Left" },
  { value: "justify", label: "Justified" },
];

const FONT_OPTIONS: { value: FontFamily; label: string }[] = [
  { value: "system", label: "System" },
  { value: "merriweather", label: "Merriweather" },
  { value: "literata", label: "Literata" },
  { value: "inter", label: "Inter" },
  { value: "source-sans", label: "Source Sans" },
];

/**
 * Preview text for demonstrating text appearance settings.
 * Uses the same styling as actual article content.
 */
function TextPreview() {
  const { style } = useEntryTextStyles();

  return (
    <div className="border-edge-strong rounded-lg border bg-white p-4 dark:bg-zinc-800">
      <p className="ui-text-xs text-subtle mb-2 font-medium tracking-wide uppercase">Preview</p>
      <p className="text-body" style={style}>
        The quick brown fox jumps over the lazy dog. This sample text demonstrates how your articles
        will appear with the current settings. Adjusting the text size, font, and justification can
        help improve readability based on your preferences.
      </p>
    </div>
  );
}

export function AppearanceSettings() {
  const { settings, updateSettings } = useAppearance();
  const { theme, setTheme, resolvedTheme } = useTheme();

  return (
    <div className="space-y-8">
      {/* Theme Section */}
      <SettingsSection title="Theme">
        <OptionGroup
          label="Color Mode"
          description={
            theme === "system" && resolvedTheme
              ? `Following system preference (currently ${resolvedTheme})`
              : theme === "system"
                ? "Following system preference"
                : undefined
          }
          value={theme || "system"}
          options={THEME_OPTIONS}
          onChange={setTheme}
        />
      </SettingsSection>

      {/* Article Text Section */}
      <SettingsSection
        title="Article Text"
        description="These settings affect how article content is displayed in the entry view."
      >
        <div className="space-y-6">
          <OptionGroup
            label="Text Size"
            value={settings.textSize}
            options={TEXT_SIZE_OPTIONS}
            onChange={(textSize) => updateSettings({ textSize })}
          />

          <OptionGroup
            label="Font"
            value={settings.fontFamily}
            options={FONT_OPTIONS}
            onChange={(fontFamily) => updateSettings({ fontFamily })}
          />

          <OptionGroup
            label="Text Alignment"
            value={settings.textJustification}
            options={JUSTIFICATION_OPTIONS}
            onChange={(textJustification) => updateSettings({ textJustification })}
          />

          <TextPreview />
        </div>
      </SettingsSection>
    </div>
  );
}
