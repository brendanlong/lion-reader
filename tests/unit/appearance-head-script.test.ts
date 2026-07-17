/**
 * Unit tests for the blocking <head> text-appearance script.
 *
 * The script is a hand-written string that runs before the bundle loads, so it
 * necessarily re-implements the validate/merge + CSS-var formula that the React
 * runtime uses. These tests execute the actual generated script against a fake
 * localStorage/document and assert it produces exactly `entryTextStyleVars(...)`
 * of the coerced settings — pinning the two mirrors together so a change to the
 * font metrics/sizes/formula in one can't silently diverge from the other.
 */

import { describe, it, expect } from "vitest";
import {
  buildTextAppearanceScript,
  coerceAppearanceSettings,
  entryTextStyleVars,
  DEFAULT_APPEARANCE_SETTINGS,
  TEXT_SIZES,
  FONT_FAMILIES,
  TEXT_JUSTIFICATIONS,
  type AppearanceSettings,
} from "../../src/lib/appearance/config";

/**
 * Run the generated head script with a stubbed `localStorage`/`document` and
 * return the CSS custom properties it set on documentElement.
 */
function runHeadScript(storedValue: string | null): Record<string, string> {
  const props: Record<string, string> = {};
  const fakeLocalStorage = { getItem: () => storedValue };
  const fakeDocument = {
    documentElement: {
      style: {
        setProperty: (prop: string, value: string) => {
          props[prop] = value;
        },
      },
    },
  };
  // The script is an IIFE referencing `localStorage`/`document`/`JSON` as globals;
  // supply the first two as params that shadow them.
  const fn = new Function("localStorage", "document", buildTextAppearanceScript());
  fn(fakeLocalStorage, fakeDocument);
  return props;
}

describe("buildTextAppearanceScript", () => {
  it("applies defaults when nothing is stored", () => {
    expect(runHeadScript(null)).toEqual(entryTextStyleVars(DEFAULT_APPEARANCE_SETTINGS));
  });

  it("applies defaults on malformed JSON", () => {
    expect(runHeadScript("{not json")).toEqual(entryTextStyleVars(DEFAULT_APPEARANCE_SETTINGS));
  });

  it("matches entryTextStyleVars for every size × font × justification", () => {
    for (const textSize of TEXT_SIZES) {
      for (const fontFamily of FONT_FAMILIES) {
        for (const textJustification of TEXT_JUSTIFICATIONS) {
          const settings: AppearanceSettings = {
            textSize,
            fontFamily,
            textJustification,
            listDensity: "comfortable",
          };
          expect(runHeadScript(JSON.stringify(settings))).toEqual(entryTextStyleVars(settings));
        }
      }
    }
  });

  it("ignores unknown field values and falls back to defaults for them", () => {
    const stored = JSON.stringify({
      textSize: "gigantic",
      fontFamily: "comic-sans",
      textJustification: "center",
    });
    const expected = entryTextStyleVars(
      coerceAppearanceSettings(JSON.parse(stored) as Partial<AppearanceSettings>)
    );
    expect(runHeadScript(stored)).toEqual(expected);
    expect(runHeadScript(stored)).toEqual(entryTextStyleVars(DEFAULT_APPEARANCE_SETTINGS));
  });
});
