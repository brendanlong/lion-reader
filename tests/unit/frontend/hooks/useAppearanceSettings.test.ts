/**
 * @vitest-environment jsdom
 */

/**
 * Unit tests for useAppearanceSettings: what it reads from localStorage, and
 * that a change saves only the fields it changed (#2280).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook, act, cleanup } from "@testing-library/react";
import { stubMemoryLocalStorage } from "../../../utils/component-test-helpers";

const localStorageMock = stubMemoryLocalStorage();

// The storage key the blocking <head> script reads too.
const STORAGE_KEY = "lion-reader-appearance-settings";

/** The hook from a freshly loaded module, so its in-memory cache starts empty. */
async function renderAppearanceSettings() {
  vi.resetModules();
  const { useAppearanceSettings } = await import("@/lib/appearance/settings");
  return renderHook(() => useAppearanceSettings());
}

function stored(): unknown {
  return JSON.parse(localStorageMock.getItem(STORAGE_KEY) ?? "null");
}

describe("useAppearanceSettings", () => {
  beforeEach(() => {
    localStorageMock.clear();
    cleanup();
  });

  afterEach(() => {
    cleanup();
  });

  it("reads stored settings, with unknown or missing fields at their defaults", async () => {
    localStorageMock.setItem(STORAGE_KEY, JSON.stringify({ textSize: "large", fontFamily: "x" }));
    const { DEFAULT_APPEARANCE_SETTINGS } = await import("@/lib/appearance/config");
    const { result } = await renderAppearanceSettings();

    expect(result.current[0]).toEqual({ ...DEFAULT_APPEARANCE_SETTINGS, textSize: "large" });
  });

  it.each(["null", "[]", "not json"])("reads %s as the defaults", async (raw) => {
    localStorageMock.setItem(STORAGE_KEY, raw);
    const { DEFAULT_APPEARANCE_SETTINGS } = await import("@/lib/appearance/config");
    const { result } = await renderAppearanceSettings();

    expect(result.current[0]).toEqual(DEFAULT_APPEARANCE_SETTINGS);
  });

  it("saves only the field a change makes, so the rest keep following their defaults (#2280)", async () => {
    const { result } = await renderAppearanceSettings();

    act(() => result.current[1]({ ...result.current[0], textSize: "large" }));

    expect(stored()).toEqual({ textSize: "large" });
    expect(result.current[0].textSize).toBe("large");
  });

  it("keeps a field another tab stored when this tab changes a different one", async () => {
    const { result } = await renderAppearanceSettings();
    // Read before the other tab's write, so this tab's copy predates it.
    expect(result.current[0].fontFamily).toBe("system");
    localStorageMock.setItem(STORAGE_KEY, JSON.stringify({ fontFamily: "literata" }));

    act(() => result.current[1]({ ...result.current[0], textSize: "small" }));

    expect(stored()).toEqual({ fontFamily: "literata", textSize: "small" });
  });
});
