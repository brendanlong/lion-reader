/**
 * @vitest-environment jsdom
 */

/**
 * Unit tests for useShowOriginalPreference hook.
 *
 * Tests the per-feed preference for showing original vs cleaned content.
 *
 * Note: The hook uses module-level caches, so we need to reset modules between
 * tests that read pre-populated localStorage values.
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

vi.stubGlobal("localStorage", localStorageMock);

describe("useShowOriginalPreference", () => {
  beforeEach(() => {
    localStorageMock.clear();
    vi.clearAllMocks();
    cleanup();
    vi.resetModules();
  });

  afterEach(() => {
    localStorageMock.clear();
    cleanup();
  });

  describe("default values", () => {
    it("returns false by default when no preference is stored", async () => {
      const { useShowOriginalPreference } = await import("@/lib/hooks/useShowOriginalPreference");
      const { result } = renderHook(() => useShowOriginalPreference("default-feed-1"));

      expect(result.current[0]).toBe(false);
    });

    it("returns false when feedId is undefined", async () => {
      const { useShowOriginalPreference } = await import("@/lib/hooks/useShowOriginalPreference");
      const { result } = renderHook(() => useShowOriginalPreference(undefined));

      expect(result.current[0]).toBe(false);
    });
  });

  describe("localStorage persistence", () => {
    it("reads existing preference from localStorage", async () => {
      localStorageMock.setItem("lion-reader:show-original:read-true-feed", JSON.stringify(true));
      vi.resetModules();

      const { useShowOriginalPreference } = await import("@/lib/hooks/useShowOriginalPreference");
      const { result } = renderHook(() => useShowOriginalPreference("read-true-feed"));

      expect(result.current[0]).toBe(true);
    });

    it("reads false preference from localStorage", async () => {
      localStorageMock.setItem("lion-reader:show-original:read-false-feed", JSON.stringify(false));
      vi.resetModules();

      const { useShowOriginalPreference } = await import("@/lib/hooks/useShowOriginalPreference");
      const { result } = renderHook(() => useShowOriginalPreference("read-false-feed"));

      expect(result.current[0]).toBe(false);
    });

    it("saves preference to localStorage when changed", async () => {
      vi.resetModules();
      const { useShowOriginalPreference } = await import("@/lib/hooks/useShowOriginalPreference");
      const { result } = renderHook(() => useShowOriginalPreference("save-pref-feed"));

      act(() => {
        result.current[1](true);
      });

      expect(localStorageMock.setItem).toHaveBeenCalledWith(
        "lion-reader:show-original:save-pref-feed",
        JSON.stringify(true)
      );
    });

    it("uses correct storage key format", async () => {
      vi.resetModules();
      const feedId = "abc-123-def";
      const { useShowOriginalPreference } = await import("@/lib/hooks/useShowOriginalPreference");
      const { result } = renderHook(() => useShowOriginalPreference(feedId));

      act(() => {
        result.current[1](true);
      });

      expect(localStorageMock.setItem).toHaveBeenCalledWith(
        `lion-reader:show-original:${feedId}`,
        JSON.stringify(true)
      );
    });
  });

  describe("per-feed preferences", () => {
    it("stores preferences separately per feed", async () => {
      localStorageMock.setItem("lion-reader:show-original:per-feed-a", JSON.stringify(true));
      localStorageMock.setItem("lion-reader:show-original:per-feed-b", JSON.stringify(false));
      vi.resetModules();

      const { useShowOriginalPreference } = await import("@/lib/hooks/useShowOriginalPreference");
      const { result: resultA } = renderHook(() => useShowOriginalPreference("per-feed-a"));
      const { result: resultB } = renderHook(() => useShowOriginalPreference("per-feed-b"));

      expect(resultA.current[0]).toBe(true);
      expect(resultB.current[0]).toBe(false);
    });
  });

  describe("setting preference", () => {
    it("updates state when setShowOriginal is called with true", async () => {
      vi.resetModules();
      const { useShowOriginalPreference } = await import("@/lib/hooks/useShowOriginalPreference");
      const { result } = renderHook(() => useShowOriginalPreference("set-true-feed"));

      expect(result.current[0]).toBe(false);

      act(() => {
        result.current[1](true);
      });

      expect(result.current[0]).toBe(true);
    });

    it("updates state when setShowOriginal is called with false", async () => {
      localStorageMock.setItem("lion-reader:show-original:set-false-feed", JSON.stringify(true));
      vi.resetModules();

      const { useShowOriginalPreference } = await import("@/lib/hooks/useShowOriginalPreference");
      const { result } = renderHook(() => useShowOriginalPreference("set-false-feed"));

      expect(result.current[0]).toBe(true);

      act(() => {
        result.current[1](false);
      });

      expect(result.current[0]).toBe(false);
    });

    it("does nothing when feedId is undefined", async () => {
      vi.resetModules();
      const { useShowOriginalPreference } = await import("@/lib/hooks/useShowOriginalPreference");
      const { result } = renderHook(() => useShowOriginalPreference(undefined));

      act(() => {
        result.current[1](true);
      });

      // Should still be false, setter is a no-op
      expect(result.current[0]).toBe(false);
      expect(localStorageMock.setItem).not.toHaveBeenCalled();
    });
  });

  describe("error handling", () => {
    it("handles invalid JSON gracefully", async () => {
      localStorageMock.setItem("lion-reader:show-original:invalid-json-feed", "not valid json");
      vi.resetModules();

      const { useShowOriginalPreference } = await import("@/lib/hooks/useShowOriginalPreference");
      const { result } = renderHook(() => useShowOriginalPreference("invalid-json-feed"));

      expect(result.current[0]).toBe(false);
    });

    it("handles non-boolean values gracefully", async () => {
      localStorageMock.setItem("lion-reader:show-original:non-boolean-feed", JSON.stringify("yes"));
      vi.resetModules();

      const { useShowOriginalPreference } = await import("@/lib/hooks/useShowOriginalPreference");
      const { result } = renderHook(() => useShowOriginalPreference("non-boolean-feed"));

      // Since "yes" !== true, it returns false
      expect(result.current[0]).toBe(false);
    });
  });

  describe("return value stability", () => {
    it("returns a stable setter function", async () => {
      vi.resetModules();
      const { useShowOriginalPreference } = await import("@/lib/hooks/useShowOriginalPreference");
      const { result, rerender } = renderHook(() => useShowOriginalPreference("stability-feed"));

      const firstSetter = result.current[1];
      rerender();
      const secondSetter = result.current[1];

      expect(firstSetter).toBe(secondSetter);
    });
  });

  describe("shared state between hook instances", () => {
    it("updates all hook instances when preference changes", async () => {
      vi.resetModules();
      const { useShowOriginalPreference } = await import("@/lib/hooks/useShowOriginalPreference");

      const { result: result1 } = renderHook(() => useShowOriginalPreference("shared-feed"));
      const { result: result2 } = renderHook(() => useShowOriginalPreference("shared-feed"));

      expect(result1.current[0]).toBe(false);
      expect(result2.current[0]).toBe(false);

      act(() => {
        result1.current[1](true);
      });

      // Both instances should see the update
      expect(result1.current[0]).toBe(true);
      expect(result2.current[0]).toBe(true);
    });
  });
});
