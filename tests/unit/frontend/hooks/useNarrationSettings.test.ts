/**
 * @vitest-environment jsdom
 */

/**
 * Unit tests for useNarrationSettings hook.
 *
 * Tests the narration settings management with localStorage persistence.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { stubMemoryLocalStorage } from "../../../utils/component-test-helpers";
import { renderHook, act, cleanup } from "@testing-library/react";
import { act as reactAct, createElement } from "react";
import { renderToString } from "react-dom/server";
import { hydrateRoot } from "react-dom/client";

const localStorageMock = stubMemoryLocalStorage();
vi.spyOn(localStorageMock, "setItem");

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
  });

  describe("localStorage persistence", () => {
    it("reads existing settings from localStorage", () => {
      const storedSettings = {
        enabled: false,
        provider: "piper",
        cloudModelId: null,
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

      const savedCall = vi
        .mocked(localStorageMock.setItem)
        .mock.calls.find((call) => call[0] === "lion-reader-narration-settings");
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
  });

  describe("shared state", () => {
    it("propagates a change to every mounted instance", () => {
      // e.g. the settings page disabling narration must reach the open
      // entry's player, which stops when `enabled` flips off.
      const player = renderHook(() => useNarrationSettings());
      const settingsPage = renderHook(() => useNarrationSettings());

      act(() => {
        settingsPage.result.current[1]((prev) => ({ ...prev, enabled: false }));
      });

      expect(player.result.current[0].enabled).toBe(false);
    });

    it("picks up a change another tab made", () => {
      const { result } = renderHook(() => useNarrationSettings());
      expect(result.current[0].rate).toBe(1.0);

      // The other tab's write lands in (shared) storage, then the browser
      // fires `storage` in this tab.
      const stored = JSON.stringify({ ...DEFAULT_NARRATION_SETTINGS, rate: 1.25 });
      localStorageMock.setItem("lion-reader-narration-settings", stored);
      act(() => {
        window.dispatchEvent(
          new StorageEvent("storage", { key: "lion-reader-narration-settings", newValue: stored })
        );
      });

      expect(result.current[0].rate).toBe(1.25);
    });

    it("composes functional updates made back to back", () => {
      const { result } = renderHook(() => useNarrationSettings());

      act(() => {
        result.current[1]((prev) => ({ ...prev, rate: 1.5 }));
        result.current[1]((prev) => ({ ...prev, pitch: 0.75 }));
      });

      expect(result.current[0].rate).toBe(1.5);
      expect(result.current[0].pitch).toBe(0.75);
    });
  });

  describe("server rendering", () => {
    it("renders the defaults on the server and the stored settings after hydration", async () => {
      localStorageMock.setItem(
        "lion-reader-narration-settings",
        JSON.stringify({ ...DEFAULT_NARRATION_SETTINGS, enabled: false })
      );

      function Probe() {
        const [settings] = useNarrationSettings();
        return createElement("span", null, settings.enabled ? "on" : "off");
      }

      // The server has no localStorage, so the server render must produce the
      // default regardless of what the browser has stored (#1552).
      const serverHtml = renderToString(createElement(Probe));
      expect(serverHtml).toBe("<span>on</span>");

      const container = document.createElement("div");
      container.innerHTML = serverHtml;
      document.body.appendChild(container);

      const recoverableErrors: unknown[] = [];
      let root: ReturnType<typeof hydrateRoot> | undefined;
      await reactAct(async () => {
        root = hydrateRoot(container, createElement(Probe), {
          onRecoverableError: (error) => {
            recoverableErrors.push(error);
          },
        });
      });

      expect(recoverableErrors).toEqual([]);
      expect(container.textContent).toBe("off");

      await reactAct(async () => {
        root?.unmount();
      });
      container.remove();
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
        cloudModelId: null,
        voiceId: "custom-voice",
        rate: 1.75,
        pitch: 0.9,
        highlightEnabled: false,
        autoScrollEnabled: false,
        useLlmNormalization: true,
        sentenceGapSeconds: 0.5,
        cloudPauseSeconds: 1,
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
