/**
 * Unit tests for narration settings loading and migration.
 *
 * Tests the pure logic of settings parsing and migration from
 * old formats (voiceUri) to new formats (voiceId, provider).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Mock localStorage before importing the settings module
const localStorageMock = (() => {
  let store: Record<string, string> = {};
  return {
    getItem: vi.fn((key: string) => store[key] || null),
    setItem: vi.fn((key: string, value: string) => {
      store[key] = value;
    }),
    removeItem: vi.fn((key: string) => {
      delete store[key];
    }),
    clear: vi.fn(() => {
      store = {};
    }),
  };
})();

// Mock window and localStorage
vi.stubGlobal("window", { localStorage: localStorageMock });
vi.stubGlobal("localStorage", localStorageMock);

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

    it("returns defaults when localStorage item is missing", () => {
      const settings = loadNarrationSettings();

      expect(settings.enabled).toBe(true);
      expect(settings.provider).toBe("browser");
      expect(settings.voiceId).toBeNull();
      expect(settings.rate).toBe(1.0);
      expect(settings.pitch).toBe(1.0);
    });
  });

  describe("parsing stored values", () => {
    it("parses enabled boolean correctly", () => {
      localStorageMock.setItem(
        "lion-reader-narration-settings",
        JSON.stringify({ enabled: false })
      );

      const settings = loadNarrationSettings();
      expect(settings.enabled).toBe(false);
    });

    it("parses provider correctly", () => {
      localStorageMock.setItem(
        "lion-reader-narration-settings",
        JSON.stringify({ provider: "piper" })
      );

      const settings = loadNarrationSettings();
      expect(settings.provider).toBe("piper");
    });

    it("parses voiceId correctly", () => {
      localStorageMock.setItem(
        "lion-reader-narration-settings",
        JSON.stringify({ voiceId: "test-voice-id" })
      );

      const settings = loadNarrationSettings();
      expect(settings.voiceId).toBe("test-voice-id");
    });

    it("parses rate correctly", () => {
      localStorageMock.setItem("lion-reader-narration-settings", JSON.stringify({ rate: 1.5 }));

      const settings = loadNarrationSettings();
      expect(settings.rate).toBe(1.5);
    });

    it("parses pitch correctly", () => {
      localStorageMock.setItem("lion-reader-narration-settings", JSON.stringify({ pitch: 0.8 }));

      const settings = loadNarrationSettings();
      expect(settings.pitch).toBe(0.8);
    });
  });

  describe("migration from voiceUri to voiceId", () => {
    it("migrates voiceUri to voiceId when voiceId is not present", () => {
      localStorageMock.setItem(
        "lion-reader-narration-settings",
        JSON.stringify({ voiceUri: "old-voice-uri" })
      );

      const settings = loadNarrationSettings();
      expect(settings.voiceId).toBe("old-voice-uri");
    });

    it("prefers voiceId over voiceUri when both are present", () => {
      localStorageMock.setItem(
        "lion-reader-narration-settings",
        JSON.stringify({
          voiceUri: "old-voice-uri",
          voiceId: "new-voice-id",
        })
      );

      const settings = loadNarrationSettings();
      expect(settings.voiceId).toBe("new-voice-id");
    });

    it("handles null voiceUri gracefully", () => {
      localStorageMock.setItem(
        "lion-reader-narration-settings",
        JSON.stringify({ voiceUri: null })
      );

      const settings = loadNarrationSettings();
      expect(settings.voiceId).toBeNull();
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

    it("accepts browser as valid provider", () => {
      localStorageMock.setItem(
        "lion-reader-narration-settings",
        JSON.stringify({ provider: "browser" })
      );

      const settings = loadNarrationSettings();
      expect(settings.provider).toBe("browser");
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

  it("saves settings to localStorage", () => {
    const settings: NarrationSettings = {
      enabled: false,
      provider: "piper",
      voiceId: "test-voice",
      rate: 1.5,
      pitch: 0.8,
    };

    saveNarrationSettings(settings);

    expect(localStorageMock.setItem).toHaveBeenCalledWith(
      "lion-reader-narration-settings",
      JSON.stringify(settings)
    );
  });

  it("roundtrips settings correctly", () => {
    const originalSettings: NarrationSettings = {
      enabled: false,
      provider: "piper",
      voiceId: "en_US-lessac-medium",
      rate: 1.75,
      pitch: 0.9,
    };

    saveNarrationSettings(originalSettings);
    const loadedSettings = loadNarrationSettings();

    expect(loadedSettings).toEqual(originalSettings);
  });
});

describe("DEFAULT_NARRATION_SETTINGS", () => {
  it("has expected default values", () => {
    expect(DEFAULT_NARRATION_SETTINGS.enabled).toBe(true);
    expect(DEFAULT_NARRATION_SETTINGS.provider).toBe("browser");
    expect(DEFAULT_NARRATION_SETTINGS.voiceId).toBeNull();
    expect(DEFAULT_NARRATION_SETTINGS.rate).toBe(1.0);
    expect(DEFAULT_NARRATION_SETTINGS.pitch).toBe(1.0);
  });
});
