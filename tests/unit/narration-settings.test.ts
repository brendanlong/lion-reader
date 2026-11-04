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
  DEFAULT_NARRATION_SETTINGS,
  narrationProvider,
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

    it("accepts phonon as valid provider", () => {
      localStorageMock.setItem(
        "lion-reader-narration-settings",
        JSON.stringify({ provider: "phonon" })
      );

      const settings = loadNarrationSettings();
      expect(settings.provider).toBe("phonon");
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

describe("stored settings", () => {
  beforeEach(() => {
    localStorageMock.clear();
    vi.clearAllMocks();
  });

  it("reads back every stored field", () => {
    const originalSettings: NarrationSettings = {
      enabled: false,
      provider: "phonon",
      cloudModelId: null,
      voiceId: "bXwrkHhURL1VFJdG",
      rate: 1.75,
      pitch: 0.9,
      highlightEnabled: true,
      autoScrollEnabled: false,
      continueToNextArticle: false,
      useLlmNormalization: false,
      sentenceGapSeconds: 0.5,
      cloudPauseSeconds: 0.75,
    };

    localStorageMock.setItem("lion-reader-narration-settings", JSON.stringify(originalSettings));
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

describe("narrationProvider", () => {
  const listed = { data: { models: [{}] }, isError: false };
  const none = { data: { models: [] }, isError: false };
  const pending = { isError: false };
  const failed = { isError: true };

  it("uses cloud voices while the server lists some, or hasn't answered yet", () => {
    expect(narrationProvider("cloud", listed, true)).toBe("cloud");
    expect(narrationProvider("cloud", pending, true)).toBe("cloud");
  });

  it("uses built-in voices when the server lists no cloud voices or can't be reached", () => {
    expect(narrationProvider("cloud", none, true)).toBe("browser");
    expect(narrationProvider("cloud", failed, true)).toBe("browser");
    // A refetch that failed keeps the old answer's data.
    expect(narrationProvider("cloud", { ...listed, isError: true }, true)).toBe("browser");
  });

  it("uses built-in voices when the browser can't stream cloud audio", () => {
    expect(narrationProvider("cloud", listed, false)).toBe("browser");
  });

  it("leaves other choices alone", () => {
    expect(narrationProvider("phonon", none, true)).toBe("phonon");
    expect(narrationProvider("browser", listed, true)).toBe("browser");
  });
});
