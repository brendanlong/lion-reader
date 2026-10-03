/**
 * Unit tests for narration settings loading.
 *
 * Tests the pure logic of settings parsing, validation, and merging with defaults.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { stubMemoryLocalStorage } from "../utils/component-test-helpers";

const localStorageMock = stubMemoryLocalStorage();
// Mock window (settings.ts bails out when it is undefined)
vi.stubGlobal("window", { localStorage: localStorageMock });

// Now import the module under test
import {
  loadNarrationSettings,
  saveNarrationSettings,
  DEFAULT_NARRATION_SETTINGS,
  type NarrationSettings,
} from "../../src/lib/narration/settings";

describe("loadNarrationSettings", () => {
  beforeEach(() => {
    localStorageMock.clear();
    vi.clearAllMocks();
  });

  afterEach(() => {
    localStorageMock.clear();
  });

  describe("default values", () => {
    it("returns defaults when localStorage is empty", () => {
      const settings = loadNarrationSettings();

      expect(settings).toEqual(DEFAULT_NARRATION_SETTINGS);
    });
  });

  describe("provider validation", () => {
    it("defaults to browser for invalid provider values", () => {
      localStorageMock.setItem(
        "lion-reader-narration-settings",
        JSON.stringify({ provider: "invalid-provider" })
      );

      const settings = loadNarrationSettings();
      expect(settings.provider).toBe("browser");
    });

    it("defaults to browser when provider is missing", () => {
      localStorageMock.setItem("lion-reader-narration-settings", JSON.stringify({ enabled: true }));

      const settings = loadNarrationSettings();
      expect(settings.provider).toBe("browser");
    });

    it("accepts piper as valid provider", () => {
      localStorageMock.setItem(
        "lion-reader-narration-settings",
        JSON.stringify({ provider: "piper" })
      );

      const settings = loadNarrationSettings();
      expect(settings.provider).toBe("piper");
    });
  });

  describe("rate validation", () => {
    it("clamps rate below minimum to default", () => {
      localStorageMock.setItem("lion-reader-narration-settings", JSON.stringify({ rate: 0.1 }));

      const settings = loadNarrationSettings();
      expect(settings.rate).toBe(1.0); // Falls back to default
    });

    it("clamps rate above maximum to default", () => {
      localStorageMock.setItem("lion-reader-narration-settings", JSON.stringify({ rate: 5.0 }));

      const settings = loadNarrationSettings();
      expect(settings.rate).toBe(1.0); // Falls back to default
    });

    it("accepts rate at minimum boundary", () => {
      localStorageMock.setItem("lion-reader-narration-settings", JSON.stringify({ rate: 0.5 }));

      const settings = loadNarrationSettings();
      expect(settings.rate).toBe(0.5);
    });

    it("accepts rate at maximum boundary", () => {
      localStorageMock.setItem("lion-reader-narration-settings", JSON.stringify({ rate: 2.0 }));

      const settings = loadNarrationSettings();
      expect(settings.rate).toBe(2.0);
    });
  });

  describe("pitch validation", () => {
    it("clamps pitch below minimum to default", () => {
      localStorageMock.setItem("lion-reader-narration-settings", JSON.stringify({ pitch: 0.1 }));

      const settings = loadNarrationSettings();
      expect(settings.pitch).toBe(1.0); // Falls back to default
    });

    it("clamps pitch above maximum to default", () => {
      localStorageMock.setItem("lion-reader-narration-settings", JSON.stringify({ pitch: 5.0 }));

      const settings = loadNarrationSettings();
      expect(settings.pitch).toBe(1.0); // Falls back to default
    });
  });

  describe("error handling", () => {
    it("returns defaults for invalid JSON", () => {
      localStorageMock.setItem("lion-reader-narration-settings", "not valid json");

      const settings = loadNarrationSettings();
      expect(settings).toEqual(DEFAULT_NARRATION_SETTINGS);
    });

    it("returns defaults for null values in object", () => {
      localStorageMock.setItem(
        "lion-reader-narration-settings",
        JSON.stringify({ enabled: null, rate: null, pitch: null })
      );

      const settings = loadNarrationSettings();
      expect(settings.enabled).toBe(true); // Falls back to default
      expect(settings.rate).toBe(1.0); // Falls back to default
      expect(settings.pitch).toBe(1.0); // Falls back to default
    });
  });
});

describe("saveNarrationSettings", () => {
  beforeEach(() => {
    localStorageMock.clear();
    vi.clearAllMocks();
  });

  it("roundtrips settings correctly", () => {
    const originalSettings: NarrationSettings = {
      enabled: false,
      provider: "piper",
      cloudModelId: null,
      voiceId: "en_US-lessac-medium",
      rate: 1.75,
      pitch: 0.9,
      highlightEnabled: true,
      autoScrollEnabled: false,
      useLlmNormalization: false,
      sentenceGapSeconds: 0.5,
      cloudPauseSeconds: 0.75,
    };

    saveNarrationSettings(originalSettings);
    const loadedSettings = loadNarrationSettings();

    expect(loadedSettings).toEqual(originalSettings);
  });
});

describe("cloud voice pause", () => {
  beforeEach(() => {
    localStorageMock.clear();
  });

  it("keeps a stored pause in range and replaces one outside it", () => {
    localStorageMock.setItem(
      "lion-reader-narration-settings",
      JSON.stringify({ cloudPauseSeconds: 0.5 })
    );
    expect(loadNarrationSettings().cloudPauseSeconds).toBe(0.5);

    localStorageMock.setItem(
      "lion-reader-narration-settings",
      JSON.stringify({ cloudPauseSeconds: 60 })
    );
    expect(loadNarrationSettings().cloudPauseSeconds).toBe(
      DEFAULT_NARRATION_SETTINGS.cloudPauseSeconds
    );
  });
});

describe("highlighting settings", () => {
  beforeEach(() => {
    localStorageMock.clear();
    vi.clearAllMocks();
  });

  it("parses highlightEnabled correctly", () => {
    localStorageMock.setItem(
      "lion-reader-narration-settings",
      JSON.stringify({ highlightEnabled: false })
    );

    const settings = loadNarrationSettings();
    expect(settings.highlightEnabled).toBe(false);
  });

  it("defaults highlightEnabled and autoScrollEnabled to true when missing", () => {
    localStorageMock.setItem("lion-reader-narration-settings", JSON.stringify({ enabled: true }));

    const settings = loadNarrationSettings();
    expect(settings.highlightEnabled).toBe(true);
    expect(settings.autoScrollEnabled).toBe(true);
  });

  it("handles non-boolean highlightEnabled gracefully", () => {
    localStorageMock.setItem(
      "lion-reader-narration-settings",
      JSON.stringify({ highlightEnabled: "yes" })
    );

    const settings = loadNarrationSettings();
    expect(settings.highlightEnabled).toBe(true); // Falls back to default
  });

  it("handles non-boolean autoScrollEnabled gracefully", () => {
    localStorageMock.setItem(
      "lion-reader-narration-settings",
      JSON.stringify({ autoScrollEnabled: null })
    );

    const settings = loadNarrationSettings();
    expect(settings.autoScrollEnabled).toBe(true); // Falls back to default
  });
});
