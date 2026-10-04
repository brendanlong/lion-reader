/**
 * @vitest-environment jsdom
 */

/**
 * Unit tests for useShowOriginalPreference hook.
 *
 * Tests the per-subscription preference for showing original vs cleaned content.
 *
 * Note: The hook uses module-level caches, so we need to reset modules between
 * tests that read pre-populated localStorage values.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { stubMemoryLocalStorage } from "../../../utils/component-test-helpers";
import { renderHook, act, cleanup } from "@testing-library/react";

const localStorageMock = stubMemoryLocalStorage();
vi.spyOn(localStorageMock, "setItem");

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
      const { result } = renderHook(() => useShowOriginalPreference("default-key-1"));

      expect(result.current[0]).toBe(false);
    });

    it("returns false when the key is undefined", async () => {
      const { useShowOriginalPreference } = await import("@/lib/hooks/useShowOriginalPreference");
      const { result } = renderHook(() => useShowOriginalPreference(undefined));

      expect(result.current[0]).toBe(false);
    });
  });

  describe("localStorage persistence", () => {
    it("reads existing preference from localStorage", async () => {
      localStorageMock.setItem("lion-reader:show-original:read-true-key", JSON.stringify(true));
      vi.resetModules();

      const { useShowOriginalPreference } = await import("@/lib/hooks/useShowOriginalPreference");
      const { result } = renderHook(() => useShowOriginalPreference("read-true-key"));

      expect(result.current[0]).toBe(true);
    });

    it("saves preference to localStorage when changed", async () => {
      vi.resetModules();
      const { useShowOriginalPreference } = await import("@/lib/hooks/useShowOriginalPreference");
      const { result } = renderHook(() => useShowOriginalPreference("save-pref-key"));

      act(() => {
        result.current[1](true);
      });

      expect(localStorageMock.setItem).toHaveBeenCalledWith(
        "lion-reader:show-original:save-pref-key",
        JSON.stringify(true)
      );
    });
  });

  describe("per-key preferences", () => {
    it("stores preferences separately per key", async () => {
      localStorageMock.setItem("lion-reader:show-original:per-key-a", JSON.stringify(true));
      localStorageMock.setItem("lion-reader:show-original:per-key-b", JSON.stringify(false));
      vi.resetModules();

      const { useShowOriginalPreference } = await import("@/lib/hooks/useShowOriginalPreference");
      const { result: resultA } = renderHook(() => useShowOriginalPreference("per-key-a"));
      const { result: resultB } = renderHook(() => useShowOriginalPreference("per-key-b"));

      expect(resultA.current[0]).toBe(true);
      expect(resultB.current[0]).toBe(false);
    });
  });

  describe("setting preference", () => {
    it("updates state when setShowOriginal is called with false", async () => {
      localStorageMock.setItem("lion-reader:show-original:set-false-key", JSON.stringify(true));
      vi.resetModules();

      const { useShowOriginalPreference } = await import("@/lib/hooks/useShowOriginalPreference");
      const { result } = renderHook(() => useShowOriginalPreference("set-false-key"));

      expect(result.current[0]).toBe(true);

      act(() => {
        result.current[1](false);
      });

      expect(result.current[0]).toBe(false);
    });

    it("does nothing when the key is undefined", async () => {
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
      localStorageMock.setItem("lion-reader:show-original:invalid-json-key", "not valid json");
      vi.resetModules();

      const { useShowOriginalPreference } = await import("@/lib/hooks/useShowOriginalPreference");
      const { result } = renderHook(() => useShowOriginalPreference("invalid-json-key"));

      expect(result.current[0]).toBe(false);
    });

    it("handles non-boolean values gracefully", async () => {
      localStorageMock.setItem("lion-reader:show-original:non-boolean-key", JSON.stringify("yes"));
      vi.resetModules();

      const { useShowOriginalPreference } = await import("@/lib/hooks/useShowOriginalPreference");
      const { result } = renderHook(() => useShowOriginalPreference("non-boolean-key"));

      // Since "yes" !== true, it returns false
      expect(result.current[0]).toBe(false);
    });
  });

  describe("showOriginalKey", () => {
    it("keys by subscription, and entries without one share a key per type", async () => {
      const { showOriginalKey } = await import("@/lib/hooks/useShowOriginalPreference");

      expect(showOriginalKey({ subscriptionId: "sub-1", type: "web" })).toBe("sub-1");
      expect(showOriginalKey({ subscriptionId: null, type: "saved" })).toBe("saved");
    });
  });

  describe("return value stability", () => {
    it("returns a stable setter function", async () => {
      vi.resetModules();
      const { useShowOriginalPreference } = await import("@/lib/hooks/useShowOriginalPreference");
      const { result, rerender } = renderHook(() => useShowOriginalPreference("stability-key"));

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

      const { result: result1 } = renderHook(() => useShowOriginalPreference("shared-key"));
      const { result: result2 } = renderHook(() => useShowOriginalPreference("shared-key"));

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
