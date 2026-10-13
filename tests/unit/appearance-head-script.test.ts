/**
 * Unit tests for the blocking <head> appearance script.
 *
 * The script is a hand-written string that runs before the bundle loads, so it
 * necessarily re-implements the validate/merge + apply logic that the settings
 * store uses at runtime. These tests execute the actual generated script against
 * a fake localStorage/document and assert it leaves the document exactly as
 * `applyAppearanceSettings` of the coerced settings does — pinning the two
 * mirrors together so a change to the font metrics/sizes/formula or the density
 * attribute in one can't silently diverge from the other.
 */

import { describe, it, expect } from "vitest";
import {
  applyAppearanceSettings,
  buildTextAppearanceScript,
  coerceAppearanceSettings,
  DEFAULT_APPEARANCE_SETTINGS,
  TEXT_SIZES,
  FONT_FAMILIES,
  TEXT_JUSTIFICATIONS,
  type AppearanceRoot,
  type AppearanceSettings,
} from "../../src/lib/appearance/config";

/** A fake documentElement recording the properties and attributes set on it. */
function recordingRoot(): { root: AppearanceRoot; written: Record<string, string> } {
  const written: Record<string, string> = {};
  const root: AppearanceRoot = {
    style: {
      setProperty: (property, value) => {
        written[property] = value;
      },
    },
    setAttribute: (name, value) => {
      written[`[${name}]`] = value;
    },
  };
  return { root, written };
}

/** What the generated head script writes to documentElement. */
function runHeadScript(storedValue: string | null): Record<string, string> {
  const { root, written } = recordingRoot();
  const fakeLocalStorage = { getItem: () => storedValue };
  // The script is an IIFE referencing `localStorage`/`document`/`JSON` as globals;
  // supply the first two as params that shadow them.
  const fn = new Function("localStorage", "document", buildTextAppearanceScript());
  fn(fakeLocalStorage, { documentElement: root });
  return written;
}

/** What the runtime writes to documentElement for `settings`. */
function applied(settings: AppearanceSettings): Record<string, string> {
  const { root, written } = recordingRoot();
  applyAppearanceSettings(settings, root);
  return written;
}

describe("buildTextAppearanceScript", () => {
  it("applies defaults when nothing is stored", () => {
    expect(runHeadScript(null)).toEqual(applied(DEFAULT_APPEARANCE_SETTINGS));
  });

  it("applies defaults on malformed JSON", () => {
    expect(runHeadScript("{not json")).toEqual(applied(DEFAULT_APPEARANCE_SETTINGS));
  });

  it("matches applyAppearanceSettings for every size × font × justification × density", () => {
    for (const textSize of TEXT_SIZES) {
      for (const fontFamily of FONT_FAMILIES) {
        for (const textJustification of TEXT_JUSTIFICATIONS) {
          for (const listDensity of ["comfortable", "compact"] as const) {
            const settings: AppearanceSettings = {
              textSize,
              fontFamily,
              textJustification,
              listDensity,
            };
            expect(runHeadScript(JSON.stringify(settings))).toEqual(applied(settings));
          }
        }
      }
    }
  });

  it("ignores unknown field values and falls back to defaults for them", () => {
    const stored = JSON.stringify({
      textSize: "gigantic",
      fontFamily: "comic-sans",
      textJustification: "center",
      listDensity: "cozy",
    });
    const expected = applied(
      coerceAppearanceSettings(JSON.parse(stored) as Partial<AppearanceSettings>)
    );
    expect(runHeadScript(stored)).toEqual(expected);
    expect(runHeadScript(stored)).toEqual(applied(DEFAULT_APPEARANCE_SETTINGS));
  });
});
