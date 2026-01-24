/**
 * @vitest-environment jsdom
 */

/**
 * Unit tests for useNarrationSettings hook.
 *
 * Tests the narration settings management with localStorage persistence.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook, act, cleanup } from "@testing-library/react";

// Mock localStorage before importing the hook
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
    get length() {
      return Object.keys(store).length;
    },
    key: vi.fn((index: number) => Object.keys(store)[index] || null),
  };
})();

vi.stubGlobal("window", { localStorage: localStorageMock });
vi.stubGlobal("localStorage", localStorageMock);

// Import after mocking
import {
  useNarrationSettings,
  DEFAULT_NARRATION_SETTINGS,
  type NarrationSettings,
} from "@/lib/narration/settings";

describe("useNarrationSettings", () => {
  beforeEach(() => {
    localStorageMock.clear();
    vi.clearAllMocks();
    cleanup();
  });

  afterEach(() => {
    localStorageMock.clear();
    cleanup();
  });

  describe("default values", () => {
    it("returns default settings when localStorage is empty", () => {
      const { result } = renderHook(() => useNarrationSettings());

      expect(result.current[0]).toEqual(DEFAULT_NARRATION_SETTINGS);
    });

    it("has expected default values", () => {
      const { result } = renderHook(() => useNarrationSettings());
      const settings = result.current[0];

      expect(settings.enabled).toBe(true);
      expect(settings.provider).toBe("browser");
      expect(settings.voiceId).toBeNull();
      expect(settings.rate).toBe(1.0);
      expect(settings.pitch).toBe(1.0);
      expect(settings.highlightEnabled).toBe(true);
      expect(settings.autoScrollEnabled).toBe(true);
    });
  });

  describe("localStorage persistence", () => {
    it("reads existing settings from localStorage", () => {
      const storedSettings = {
        enabled: false,
        provider: "piper",
        voiceId: "test-voice",
        rate: 1.5,
        pitch: 0.8,
      };
      localStorageMock.setItem("lion-reader-narration-settings", JSON.stringify(storedSettings));

      const { result } = renderHook(() => useNarrationSettings());

      expect(result.current[0].enabled).toBe(false);
      expect(result.current[0].provider).toBe("piper");
      expect(result.current[0].voiceId).toBe("test-voice");
      expect(result.current[0].rate).toBe(1.5);
      expect(result.current[0].pitch).toBe(0.8);
    });

    it("saves settings to localStorage when changed with direct value", () => {
      const { result } = renderHook(() => useNarrationSettings());

      const newSettings: NarrationSettings = {
        ...DEFAULT_NARRATION_SETTINGS,
        enabled: false,
        rate: 1.5,
      };

      act(() => {
        result.current[1](newSettings);
      });

      expect(localStorageMock.setItem).toHaveBeenCalledWith(
        "lion-reader-narration-settings",
        JSON.stringify(newSettings)
      );
    });

    it("saves settings to localStorage when changed with functional update", () => {
      const { result } = renderHook(() => useNarrationSettings());

      act(() => {
        result.current[1]((prev) => ({ ...prev, rate: 1.75 }));
      });

      const savedCall = localStorageMock.setItem.mock.calls.find(
        (call) => call[0] === "lion-reader-narration-settings"
      );
      expect(savedCall).toBeDefined();

      const savedSettings = JSON.parse(savedCall![1]);
      expect(savedSettings.rate).toBe(1.75);
    });
  });

  describe("updating settings", () => {
    it("updates state when setSettings is called with direct value", () => {
      const { result } = renderHook(() => useNarrationSettings());

      expect(result.current[0].enabled).toBe(true);

      act(() => {
        result.current[1]({ ...result.current[0], enabled: false });
      });

      expect(result.current[0].enabled).toBe(false);
    });

    it("updates state when setSettings is called with functional update", () => {
      const { result } = renderHook(() => useNarrationSettings());

      expect(result.current[0].rate).toBe(1.0);

      act(() => {
        result.current[1]((prev) => ({ ...prev, rate: 2.0 }));
      });

      expect(result.current[0].rate).toBe(2.0);
    });

    it("preserves other settings when updating a single field", () => {
      const { result } = renderHook(() => useNarrationSettings());

      const originalSettings = { ...result.current[0] };

      act(() => {
        result.current[1]((prev) => ({ ...prev, voiceId: "new-voice" }));
      });

      expect(result.current[0].voiceId).toBe("new-voice");
      expect(result.current[0].enabled).toBe(originalSettings.enabled);
      expect(result.current[0].rate).toBe(originalSettings.rate);
      expect(result.current[0].pitch).toBe(originalSettings.pitch);
    });
  });

  describe("provider setting", () => {
    it("can switch to piper provider", () => {
      const { result } = renderHook(() => useNarrationSettings());

      act(() => {
        result.current[1]((prev) => ({ ...prev, provider: "piper" }));
      });

      expect(result.current[0].provider).toBe("piper");
    });

    it("can switch back to browser provider", () => {
      localStorageMock.setItem(
        "lion-reader-narration-settings",
        JSON.stringify({ provider: "piper" })
      );

      const { result } = renderHook(() => useNarrationSettings());

      act(() => {
        result.current[1]((prev) => ({ ...prev, provider: "browser" }));
      });

      expect(result.current[0].provider).toBe("browser");
    });
  });

  describe("voice selection", () => {
    it("can set voiceId", () => {
      const { result } = renderHook(() => useNarrationSettings());

      act(() => {
        result.current[1]((prev) => ({ ...prev, voiceId: "en_US-lessac-medium" }));
      });

      expect(result.current[0].voiceId).toBe("en_US-lessac-medium");
    });

    it("can clear voiceId by setting to null", () => {
      localStorageMock.setItem(
        "lion-reader-narration-settings",
        JSON.stringify({ voiceId: "some-voice" })
      );

      const { result } = renderHook(() => useNarrationSettings());

      act(() => {
        result.current[1]((prev) => ({ ...prev, voiceId: null }));
      });

      expect(result.current[0].voiceId).toBeNull();
    });
  });

  describe("playback settings", () => {
    it("can update rate", () => {
      const { result } = renderHook(() => useNarrationSettings());

      act(() => {
        result.current[1]((prev) => ({ ...prev, rate: 1.5 }));
      });

      expect(result.current[0].rate).toBe(1.5);
    });

    it("can update pitch", () => {
      const { result } = renderHook(() => useNarrationSettings());

      act(() => {
        result.current[1]((prev) => ({ ...prev, pitch: 0.8 }));
      });

      expect(result.current[0].pitch).toBe(0.8);
    });
  });

  describe("highlighting settings", () => {
    it("can disable highlighting", () => {
      const { result } = renderHook(() => useNarrationSettings());

      act(() => {
        result.current[1]((prev) => ({ ...prev, highlightEnabled: false }));
      });

      expect(result.current[0].highlightEnabled).toBe(false);
    });

    it("can disable auto-scroll", () => {
      const { result } = renderHook(() => useNarrationSettings());

      act(() => {
        result.current[1]((prev) => ({ ...prev, autoScrollEnabled: false }));
      });

      expect(result.current[0].autoScrollEnabled).toBe(false);
    });
  });

  describe("LLM normalization setting", () => {
    it("defaults to false", () => {
      const { result } = renderHook(() => useNarrationSettings());

      expect(result.current[0].useLlmNormalization).toBe(false);
    });

    it("can enable LLM normalization", () => {
      const { result } = renderHook(() => useNarrationSettings());

      act(() => {
        result.current[1]((prev) => ({ ...prev, useLlmNormalization: true }));
      });

      expect(result.current[0].useLlmNormalization).toBe(true);
    });
  });

  describe("sentence gap setting", () => {
    it("has default value of 0.1 seconds", () => {
      const { result } = renderHook(() => useNarrationSettings());

      expect(result.current[0].sentenceGapSeconds).toBe(0.1);
    });

    it("can update sentence gap", () => {
      const { result } = renderHook(() => useNarrationSettings());

      act(() => {
        result.current[1]((prev) => ({ ...prev, sentenceGapSeconds: 0.5 }));
      });

      expect(result.current[0].sentenceGapSeconds).toBe(0.5);
    });
  });

  describe("return value stability", () => {
    it("returns stable setter function", () => {
      const { result, rerender } = renderHook(() => useNarrationSettings());

      const firstSetter = result.current[1];
      rerender();
      const secondSetter = result.current[1];

      expect(firstSetter).toBe(secondSetter);
    });
  });

  describe("roundtrip", () => {
    it("correctly roundtrips all settings", () => {
      const customSettings: NarrationSettings = {
        enabled: false,
        provider: "piper",
        voiceId: "custom-voice",
        rate: 1.75,
        pitch: 0.9,
        highlightEnabled: false,
        autoScrollEnabled: false,
        useLlmNormalization: true,
        sentenceGapSeconds: 0.5,
      };

      const { result, unmount } = renderHook(() => useNarrationSettings());

      act(() => {
        result.current[1](customSettings);
      });

      // Unmount to simulate page refresh
      unmount();

      // Render a new hook instance - it should read from localStorage
      const { result: newResult } = renderHook(() => useNarrationSettings());

      expect(newResult.current[0]).toEqual(customSettings);
    });
  });
});
