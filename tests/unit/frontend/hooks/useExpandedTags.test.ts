/**
 * @vitest-environment jsdom
 */

/**
 * Unit tests for useExpandedTags hook.
 *
 * Tests the tag expansion state management with localStorage persistence.
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

// Reset module state before importing
// This ensures the internal cache is cleared for each test file
vi.resetModules();

// Note: We use dynamic imports in each test to ensure module state is reset

describe("useExpandedTags", () => {
  beforeEach(async () => {
    localStorageMock.clear();
    vi.clearAllMocks();
    cleanup();
    // Reset the module to clear internal state
    vi.resetModules();
  });

  afterEach(() => {
    localStorageMock.clear();
    cleanup();
  });

  describe("default values", () => {
    it("returns empty set by default when no state is stored", async () => {
      // Re-import after module reset
      const { useExpandedTags: freshHook } = await import("@/lib/hooks/useExpandedTags");
      const { result } = renderHook(() => freshHook());

      expect(result.current.expandedTagIds.size).toBe(0);
    });
  });

  describe("localStorage persistence", () => {
    it("reads existing expanded tags from localStorage", async () => {
      localStorageMock.setItem("lion-reader-expanded-tags", JSON.stringify(["tag-1", "tag-2"]));
      vi.resetModules();

      const { useExpandedTags: freshHook } = await import("@/lib/hooks/useExpandedTags");
      const { result } = renderHook(() => freshHook());

      expect(result.current.expandedTagIds.has("tag-1")).toBe(true);
      expect(result.current.expandedTagIds.has("tag-2")).toBe(true);
      expect(result.current.expandedTagIds.size).toBe(2);
    });

    it("saves expanded tags to localStorage when toggled", async () => {
      vi.resetModules();
      const { useExpandedTags: freshHook } = await import("@/lib/hooks/useExpandedTags");
      const { result } = renderHook(() => freshHook());

      act(() => {
        result.current.toggleExpanded("tag-3");
      });

      expect(localStorageMock.setItem).toHaveBeenCalledWith(
        "lion-reader-expanded-tags",
        expect.any(String)
      );

      const savedValue = JSON.parse(
        localStorageMock.setItem.mock.calls[localStorageMock.setItem.mock.calls.length - 1][1]
      );
      expect(savedValue).toContain("tag-3");
    });
  });

  describe("toggleExpanded", () => {
    it("adds tag to expanded set when not expanded", async () => {
      vi.resetModules();
      const { useExpandedTags: freshHook } = await import("@/lib/hooks/useExpandedTags");
      const { result } = renderHook(() => freshHook());

      expect(result.current.expandedTagIds.has("tag-4")).toBe(false);

      act(() => {
        result.current.toggleExpanded("tag-4");
      });

      expect(result.current.expandedTagIds.has("tag-4")).toBe(true);
    });

    it("removes tag from expanded set when already expanded", async () => {
      localStorageMock.setItem("lion-reader-expanded-tags", JSON.stringify(["tag-5"]));
      vi.resetModules();

      const { useExpandedTags: freshHook } = await import("@/lib/hooks/useExpandedTags");
      const { result } = renderHook(() => freshHook());

      expect(result.current.expandedTagIds.has("tag-5")).toBe(true);

      act(() => {
        result.current.toggleExpanded("tag-5");
      });

      expect(result.current.expandedTagIds.has("tag-5")).toBe(false);
    });

    it("supports uncategorized as a special key", async () => {
      vi.resetModules();
      const { useExpandedTags: freshHook } = await import("@/lib/hooks/useExpandedTags");
      const { result } = renderHook(() => freshHook());

      act(() => {
        result.current.toggleExpanded("uncategorized");
      });

      expect(result.current.expandedTagIds.has("uncategorized")).toBe(true);
    });
  });

  describe("isExpanded", () => {
    it("returns true for expanded tags", async () => {
      localStorageMock.setItem("lion-reader-expanded-tags", JSON.stringify(["tag-6"]));
      vi.resetModules();

      const { useExpandedTags: freshHook } = await import("@/lib/hooks/useExpandedTags");
      const { result } = renderHook(() => freshHook());

      expect(result.current.isExpanded("tag-6")).toBe(true);
    });

    it("returns false for collapsed tags", async () => {
      vi.resetModules();
      const { useExpandedTags: freshHook } = await import("@/lib/hooks/useExpandedTags");
      const { result } = renderHook(() => freshHook());

      expect(result.current.isExpanded("tag-7")).toBe(false);
    });

    it("is consistent with expandedTagIds", async () => {
      localStorageMock.setItem("lion-reader-expanded-tags", JSON.stringify(["tag-8"]));
      vi.resetModules();

      const { useExpandedTags: freshHook } = await import("@/lib/hooks/useExpandedTags");
      const { result } = renderHook(() => freshHook());

      expect(result.current.isExpanded("tag-8")).toBe(result.current.expandedTagIds.has("tag-8"));
      expect(result.current.isExpanded("tag-9")).toBe(result.current.expandedTagIds.has("tag-9"));
    });
  });

  describe("error handling", () => {
    it("handles invalid JSON gracefully", async () => {
      localStorageMock.setItem("lion-reader-expanded-tags", "not valid json");
      vi.resetModules();

      const { useExpandedTags: freshHook } = await import("@/lib/hooks/useExpandedTags");
      const { result } = renderHook(() => freshHook());

      expect(result.current.expandedTagIds.size).toBe(0);
    });

    it("handles non-array values gracefully", async () => {
      localStorageMock.setItem("lion-reader-expanded-tags", JSON.stringify({ key: "value" }));
      vi.resetModules();

      const { useExpandedTags: freshHook } = await import("@/lib/hooks/useExpandedTags");
      const { result } = renderHook(() => freshHook());

      expect(result.current.expandedTagIds.size).toBe(0);
    });
  });

  describe("shared state between hook instances", () => {
    it("updates all hook instances when toggled", async () => {
      vi.resetModules();
      const { useExpandedTags: freshHook } = await import("@/lib/hooks/useExpandedTags");

      const { result: result1 } = renderHook(() => freshHook());
      const { result: result2 } = renderHook(() => freshHook());

      act(() => {
        result1.current.toggleExpanded("shared-tag");
      });

      // Both instances should see the update
      expect(result1.current.expandedTagIds.has("shared-tag")).toBe(true);
      expect(result2.current.expandedTagIds.has("shared-tag")).toBe(true);
    });
  });

  describe("return value stability", () => {
    it("returns stable toggleExpanded function", async () => {
      vi.resetModules();
      const { useExpandedTags: freshHook } = await import("@/lib/hooks/useExpandedTags");
      const { result, rerender } = renderHook(() => freshHook());

      const firstToggle = result.current.toggleExpanded;
      rerender();
      const secondToggle = result.current.toggleExpanded;

      expect(firstToggle).toBe(secondToggle);
    });
  });
});
