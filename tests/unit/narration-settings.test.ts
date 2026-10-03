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
import {
  MAX_CLOUD_SPEECH_PAUSE_SECONDS,
  MAX_PITCH,
  MAX_RATE,
  MIN_PITCH,
  MIN_RATE,
} from "../../src/lib/narration/constants";

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

    it("keeps LLM text processing off by default", () => {
      // The privacy policy describes sending article text to an AI provider as opt-in.
      expect(loadNarrationSettings().useLlmNormalization).toBe(false);
    });
  });

  describe("provider validation", () => {
    it("falls back to the default for invalid provider values", () => {
      localStorageMock.setItem(
        "lion-reader-narration-settings",
        JSON.stringify({ provider: "invalid-provider" })
      );

      const settings = loadNarrationSettings();
      expect(settings.provider).toBe(DEFAULT_NARRATION_SETTINGS.provider);
    });

    it("falls back to the default when provider is missing", () => {
      localStorageMock.setItem("lion-reader-narration-settings", JSON.stringify({ enabled: true }));

      const settings = loadNarrationSettings();
      expect(settings.provider).toBe(DEFAULT_NARRATION_SETTINGS.provider);
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
      localStorageMock.setItem(
        "lion-reader-narration-settings",
        JSON.stringify({ rate: MIN_RATE / 2 })
      );

      const settings = loadNarrationSettings();
      expect(settings.rate).toBe(DEFAULT_NARRATION_SETTINGS.rate);
    });

    it("clamps rate above maximum to default", () => {
      localStorageMock.setItem(
        "lion-reader-narration-settings",
        JSON.stringify({ rate: MAX_RATE * 2 })
      );

      const settings = loadNarrationSettings();
      expect(settings.rate).toBe(DEFAULT_NARRATION_SETTINGS.rate);
    });

    it("accepts rate at minimum boundary", () => {
      localStorageMock.setItem(
        "lion-reader-narration-settings",
        JSON.stringify({ rate: MIN_RATE })
      );

      const settings = loadNarrationSettings();
      expect(settings.rate).toBe(MIN_RATE);
    });

    it("accepts rate at maximum boundary", () => {
      localStorageMock.setItem(
        "lion-reader-narration-settings",
        JSON.stringify({ rate: MAX_RATE })
      );

      const settings = loadNarrationSettings();
      expect(settings.rate).toBe(MAX_RATE);
    });
  });

  describe("pitch validation", () => {
    it("clamps pitch below minimum to default", () => {
      localStorageMock.setItem(
        "lion-reader-narration-settings",
        JSON.stringify({ pitch: MIN_PITCH / 2 })
      );

      const settings = loadNarrationSettings();
      expect(settings.pitch).toBe(DEFAULT_NARRATION_SETTINGS.pitch);
    });

    it("clamps pitch above maximum to default", () => {
      localStorageMock.setItem(
        "lion-reader-narration-settings",
        JSON.stringify({ pitch: MAX_PITCH * 2 })
      );

      const settings = loadNarrationSettings();
      expect(settings.pitch).toBe(DEFAULT_NARRATION_SETTINGS.pitch);
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
      expect(settings.enabled).toBe(DEFAULT_NARRATION_SETTINGS.enabled);
      expect(settings.rate).toBe(DEFAULT_NARRATION_SETTINGS.rate);
      expect(settings.pitch).toBe(DEFAULT_NARRATION_SETTINGS.pitch);
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
      JSON.stringify({ cloudPauseSeconds: MAX_CLOUD_SPEECH_PAUSE_SECONDS + 1 })
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

  it("falls back to the default highlightEnabled and autoScrollEnabled when missing", () => {
    localStorageMock.setItem("lion-reader-narration-settings", JSON.stringify({ enabled: true }));

    const settings = loadNarrationSettings();
    expect(settings.highlightEnabled).toBe(DEFAULT_NARRATION_SETTINGS.highlightEnabled);
    expect(settings.autoScrollEnabled).toBe(DEFAULT_NARRATION_SETTINGS.autoScrollEnabled);
  });

  it("handles non-boolean highlightEnabled gracefully", () => {
    localStorageMock.setItem(
      "lion-reader-narration-settings",
      JSON.stringify({ highlightEnabled: "yes" })
    );

    const settings = loadNarrationSettings();
    expect(settings.highlightEnabled).toBe(DEFAULT_NARRATION_SETTINGS.highlightEnabled);
  });

  it("handles non-boolean autoScrollEnabled gracefully", () => {
    localStorageMock.setItem(
      "lion-reader-narration-settings",
      JSON.stringify({ autoScrollEnabled: null })
    );

    const settings = loadNarrationSettings();
    expect(settings.autoScrollEnabled).toBe(DEFAULT_NARRATION_SETTINGS.autoScrollEnabled);
  });
});
