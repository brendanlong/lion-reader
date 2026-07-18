/**
 * Single source of truth for the text-appearance config (fonts, sizes,
 * justification). Framework-agnostic and dependency-free so it can be shared by:
 *
 * - the React runtime — the settings store (`settings.ts`) and the CSS-var
 *   applier (`useEntryTextStyles` in `AppearanceProvider.tsx`); and
 * - the blocking `<head>` script in `src/app/root-document.tsx` that sets the entry
 *   text CSS vars before first paint. That script can't import at runtime (it
 *   runs before the bundle loads), so `buildTextAppearanceScript()` here bakes
 *   this same data into the inline source. Because both sides read these
 *   constants, the numbers can't drift and reintroduce a flash of wrong
 *   size/font on navigation.
 *
 * Theme (dark/light) config lives in `../theme/config.ts`.
 */

/** localStorage key the appearance settings are persisted under. */
export const APPEARANCE_STORAGE_KEY = "lion-reader-appearance-settings";

/** Text size options for entry content. */
export const TEXT_SIZES = ["small", "medium", "large", "x-large"] as const;
/** Text justification options for entry content. */
export const TEXT_JUSTIFICATIONS = ["left", "justify"] as const;
/** Font family options for entry content. */
export const FONT_FAMILIES = [
  "system",
  "merriweather",
  "literata",
  "inter",
  "source-sans",
] as const;
/**
 * List density options for the entry list.
 *
 * - "comfortable": roomy bordered cards (the default reading view).
 * - "compact": a single divided list with tighter padding and no excerpt, for
 *   scanning/triaging many items at once.
 */
export const LIST_DENSITIES = ["comfortable", "compact"] as const;

export type TextSize = (typeof TEXT_SIZES)[number];
export type TextJustification = (typeof TEXT_JUSTIFICATIONS)[number];
export type FontFamily = (typeof FONT_FAMILIES)[number];
export type ListDensity = (typeof LIST_DENSITIES)[number];

/**
 * User preferences for text appearance.
 *
 * Note: Theme (dark/light mode) is managed by next-themes, not here.
 */
export interface AppearanceSettings {
  /** Text size for entry content. */
  textSize: TextSize;
  /** Text justification for entry content. */
  textJustification: TextJustification;
  /** Font family for entry content. */
  fontFamily: FontFamily;
  /** Vertical density of the entry list. */
  listDensity: ListDensity;
}

/** Default appearance settings. */
export const DEFAULT_APPEARANCE_SETTINGS: AppearanceSettings = {
  textSize: "medium",
  textJustification: "left",
  fontFamily: "system",
  listDensity: "comfortable",
};

/**
 * Font configuration with normalized sizing.
 *
 * Different fonts have different x-heights and metrics, so they appear different
 * sizes at the same font-size. We apply size adjustments and tuned line-heights
 * to make them visually consistent.
 */
export interface FontConfig {
  family: string;
  /** Size multiplier to normalize apparent size (1 = baseline). */
  sizeAdjust: number;
  /** Line height tuned for this font. */
  lineHeight: number;
}

export const FONT_CONFIGS: Record<FontFamily, FontConfig> = {
  system: {
    family: "inherit",
    // Varies by platform (San Francisco, Segoe UI, Roboto, etc.)
    sizeAdjust: 1,
    lineHeight: 1.7,
  },
  merriweather: {
    family: "var(--font-merriweather), Georgia, serif",
    // Smaller x-height, scale up to match Literata baseline
    sizeAdjust: 0.929,
    lineHeight: 1.8,
  },
  literata: {
    family: "var(--font-literata), Georgia, serif",
    // Baseline reference font
    sizeAdjust: 1,
    lineHeight: 1.75,
  },
  inter: {
    family: "var(--font-inter), system-ui, sans-serif",
    // Slightly smaller x-height than Literata
    sizeAdjust: 0.945,
    lineHeight: 1.7,
  },
  "source-sans": {
    family: "var(--font-source-sans), system-ui, sans-serif",
    // Larger x-height, scale down to match
    sizeAdjust: 1.061,
    lineHeight: 1.7,
  },
};

/** Base font size (rem) for each size option, before per-font sizeAdjust. */
export const BASE_SIZES: Record<TextSize, number> = {
  small: 0.875,
  medium: 1,
  large: 1.125,
  "x-large": 1.25,
};

/**
 * The `--entry-*` CSS custom properties for a given set of settings.
 *
 * The single definition of how settings map to CSS vars — used by
 * `useEntryTextStyles` at runtime and mirrored by the head script (see
 * `buildTextAppearanceScript`), which the appearance-head-script unit test pins
 * to this output so the two can't diverge.
 */
export function entryTextStyleVars(settings: AppearanceSettings): Record<string, string> {
  const fontConfig = FONT_CONFIGS[settings.fontFamily] || FONT_CONFIGS.system;
  const baseSize = BASE_SIZES[settings.textSize] || BASE_SIZES.medium;
  const adjustedSize = baseSize * fontConfig.sizeAdjust;
  return {
    "--entry-font-family": fontConfig.family,
    "--entry-font-size": `${adjustedSize}rem`,
    "--entry-line-height": String(fontConfig.lineHeight),
    "--entry-text-align": settings.textJustification === "justify" ? "justify" : "left",
  };
}

/**
 * Validate and merge a parsed (untrusted) settings object with the defaults,
 * keeping only known values. Shared by the runtime store and — via
 * `buildTextAppearanceScript`'s inlined mirror — the head script.
 */
export function coerceAppearanceSettings(parsed: Partial<AppearanceSettings>): AppearanceSettings {
  const pick = <T extends string>(value: unknown, valid: readonly T[], fallback: T): T =>
    valid.includes(value as T) ? (value as T) : fallback;
  return {
    textSize: pick(parsed.textSize, TEXT_SIZES, DEFAULT_APPEARANCE_SETTINGS.textSize),
    textJustification: pick(
      parsed.textJustification,
      TEXT_JUSTIFICATIONS,
      DEFAULT_APPEARANCE_SETTINGS.textJustification
    ),
    fontFamily: pick(parsed.fontFamily, FONT_FAMILIES, DEFAULT_APPEARANCE_SETTINGS.fontFamily),
    listDensity: pick(parsed.listDensity, LIST_DENSITIES, DEFAULT_APPEARANCE_SETTINGS.listDensity),
  };
}

/**
 * Build the blocking `<head>` script (plain ES5 string, injected via
 * dangerouslySetInnerHTML with a CSP nonce) that applies the entry text CSS vars
 * before first paint, preventing a flash of wrong size/font on full-page loads.
 *
 * All data is baked from the constants above; the inline logic mirrors
 * `coerceAppearanceSettings` (validate/merge) and `entryTextStyleVars` (the
 * size/family/line-height formula). Only the `textSize`/`textJustification`/
 * `fontFamily` fields affect CSS vars, so `listDensity` is intentionally omitted.
 */
export function buildTextAppearanceScript(): string {
  const data = {
    key: APPEARANCE_STORAGE_KEY,
    defaults: DEFAULT_APPEARANCE_SETTINGS,
    valid: {
      textSize: TEXT_SIZES,
      textJustification: TEXT_JUSTIFICATIONS,
      fontFamily: FONT_FAMILIES,
    },
    fontConfigs: FONT_CONFIGS,
    baseSizes: BASE_SIZES,
  };
  return `
(function() {
  try {
    var d = ${JSON.stringify(data)};
    var settings = {
      textSize: d.defaults.textSize,
      textJustification: d.defaults.textJustification,
      fontFamily: d.defaults.fontFamily
    };
    // Guard only the read/parse so unreadable or malformed storage leaves the
    // defaults in place (and still gets applied below), rather than skipping
    // the whole apply.
    try {
      var stored = localStorage.getItem(d.key);
      if (stored) {
        var parsed = JSON.parse(stored);
        Object.keys(d.valid).forEach(function(k) {
          if (d.valid[k].indexOf(parsed[k]) >= 0) settings[k] = parsed[k];
        });
      }
    } catch (e) {}
    var fontConfig = d.fontConfigs[settings.fontFamily] || d.fontConfigs.system;
    var baseSize = d.baseSizes[settings.textSize] || d.baseSizes.medium;
    var adjustedSize = baseSize * fontConfig.sizeAdjust;
    var style = document.documentElement.style;
    style.setProperty('--entry-font-family', fontConfig.family);
    style.setProperty('--entry-font-size', adjustedSize + 'rem');
    style.setProperty('--entry-line-height', String(fontConfig.lineHeight));
    style.setProperty('--entry-text-align', settings.textJustification === 'justify' ? 'justify' : 'left');
  } catch (e) {}
})();
`;
}
