/**
 * AppearanceSettings Component
 *
 * Settings UI for appearance preferences including:
 * - Theme mode (system/light/dark/e-paper) - powered by next-themes
 * - Text size for entry content
 * - Text justification for entry content
 * - Font family for entry content
 * - Entry list density
 */

"use client";

import { useTheme } from "next-themes";
import { SettingsSection } from "@/components/settings/SettingsSection";
import { useIsEInkDisplay } from "@/lib/theme/eink";
import { useIsHydrated } from "@/lib/hooks/useIsHydrated";
import { useAppearance, useEntryTextStyles } from "@/lib/appearance/AppearanceProvider";
import { OptionGroup } from "@/components/settings/OptionGroup";
import type {
  TextSize,
  TextJustification,
  FontFamily,
  ListDensity,
} from "@/lib/appearance/settings";

/** Theme options for next-themes (uses "system" instead of "auto") */
const THEME_OPTIONS: { value: string; label: string }[] = [
  { value: "system", label: "Auto" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
  { value: "epaper", label: "E-paper" },
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

const LIST_DENSITY_OPTIONS: { value: ListDensity; label: string }[] = [
  { value: "comfortable", label: "Comfortable" },
  { value: "compact", label: "Compact" },
];

/**
 * Preview text for demonstrating text appearance settings.
 * Uses the same styling as actual article content.
 */
function TextPreview() {
  const { style } = useEntryTextStyles();

  return (
    <div className="border-edge-strong bg-surface rounded-lg border p-4">
      <p className="ui-text-xs text-muted mb-2 font-medium tracking-wide uppercase">Preview</p>
      <p className="text-body" style={style}>
        The quick brown fox jumps over the lazy dog. This sample text demonstrates how your articles
        will appear with the current settings. Adjusting the text size, font, and justification can
        help improve readability based on your preferences.
      </p>
    </div>
  );
}

export function AppearanceSettings() {
  return (
    <div className="space-y-8">
      <ThemeSettings />
      <ArticleTextSettings />
      <EntryListSettings />
    </div>
  );
}

export function ThemeSettings() {
  const nextTheme = useTheme();
  // next-themes reads localStorage during the client's hydration render but not
  // on the server, so use its values only after hydration (#1934).
  const isHydrated = useIsHydrated();
  const theme = isHydrated ? nextTheme.theme : undefined;
  const resolvedTheme = isHydrated ? nextTheme.resolvedTheme : undefined;
  const { setTheme } = nextTheme;
  // On e-ink displays, "Auto" resolves to the e-paper theme (see ThemeProvider)
  const isEInk = useIsEInkDisplay();

  return (
    <SettingsSection title="Theme">
      <OptionGroup
        label="Color Mode"
        description={
          theme === "system" && (isEInk || resolvedTheme)
            ? `Following system preference (currently ${isEInk ? "e-paper" : resolvedTheme})`
            : theme === "system"
              ? "Following system preference"
              : theme === "epaper"
                ? "High contrast on pure white, for e-ink screens"
                : undefined
        }
        value={theme || "system"}
        options={THEME_OPTIONS}
        onChange={setTheme}
      />
    </SettingsSection>
  );
}

export function ArticleTextSettings() {
  const { settings, updateSettings } = useAppearance();

  return (
    <SettingsSection title="Article Text" description="How articles look when you open them.">
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
  );
}

export function EntryListSettings() {
  const { settings, updateSettings } = useAppearance();

  return (
    <SettingsSection title="Entry List">
      <OptionGroup
        label="List Density"
        description={
          settings.listDensity === "compact"
            ? "Tighter rows without previews, for scanning many entries."
            : "Cards with a preview snippet."
        }
        value={settings.listDensity}
        options={LIST_DENSITY_OPTIONS}
        onChange={(listDensity) => updateSettings({ listDensity })}
      />
    </SettingsSection>
  );
}
