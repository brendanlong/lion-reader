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
import {
  useAppearance,
  useEntryTextStyles,
  type TextSize,
  type TextJustification,
  type FontFamily,
} from "@/lib/appearance";

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
          ? "bg-zinc-900 text-white dark:bg-zinc-50 dark:text-zinc-900"
          : "bg-zinc-100 text-zinc-700 hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-700"
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
      <label className="ui-text-sm block font-medium text-zinc-900 dark:text-zinc-50">
        {label}
      </label>
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
      {description && (
        <p className="ui-text-sm mt-1 text-zinc-500 dark:text-zinc-400">{description}</p>
      )}
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
    <div className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-700 dark:bg-zinc-800">
      <p className="ui-text-xs mb-2 font-medium tracking-wide text-zinc-500 uppercase dark:text-zinc-400">
        Preview
      </p>
      <p className="text-zinc-700 dark:text-zinc-300" style={style}>
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
      <section>
        <h2 className="ui-text-lg mb-4 font-semibold text-zinc-900 dark:text-zinc-50">Theme</h2>
        <div className="rounded-lg border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-900">
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
        </div>
      </section>

      {/* Article Text Section */}
      <section>
        <h2 className="ui-text-lg mb-4 font-semibold text-zinc-900 dark:text-zinc-50">
          Article Text
        </h2>
        <div className="rounded-lg border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-900">
          <p className="ui-text-sm mb-6 text-zinc-600 dark:text-zinc-400">
            These settings affect how article content is displayed in the entry view.
          </p>

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
        </div>
      </section>
    </div>
  );
}
