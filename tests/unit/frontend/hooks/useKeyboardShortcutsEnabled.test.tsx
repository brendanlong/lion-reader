/**
 * @vitest-environment jsdom
 */

/**
 * Unit tests for useKeyboardShortcutsEnabled hook.
 *
 * The settings page is SSR'd, so the important property is that the server
 * render and the hydration render agree even when localStorage says the user
 * disabled shortcuts (issue #1552).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook, act, cleanup } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { hydrateRoot } from "react-dom/client";
import { act as reactAct } from "react";

// Mock localStorage before importing the hook
const localStorageMock = (() => {
  let store: Record<string, string> = {};
  return {
    getItem: vi.fn((key: string) => store[key] ?? null),
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
    key: vi.fn((index: number) => Object.keys(store)[index] ?? null),
  };
})();

vi.stubGlobal("localStorage", localStorageMock);

const STORAGE_KEY = "lion-reader:keyboard-shortcuts-enabled";

describe("useKeyboardShortcutsEnabled", () => {
  beforeEach(() => {
    localStorageMock.clear();
    vi.clearAllMocks();
    cleanup();
    // Reset the module to clear its in-memory cache
    vi.resetModules();
  });

  afterEach(() => {
    localStorageMock.clear();
    cleanup();
  });

  describe("default values", () => {
    it("returns true when nothing is stored", async () => {
      const { useKeyboardShortcutsEnabled } =
        await import("@/lib/hooks/useKeyboardShortcutsEnabled");
      const { result } = renderHook(() => useKeyboardShortcutsEnabled());

      expect(result.current.enabled).toBe(true);
    });

    it("reads a stored false value", async () => {
      localStorageMock.setItem(STORAGE_KEY, "false");

      const { useKeyboardShortcutsEnabled } =
        await import("@/lib/hooks/useKeyboardShortcutsEnabled");
      const { result } = renderHook(() => useKeyboardShortcutsEnabled());

      expect(result.current.enabled).toBe(false);
    });
  });

  describe("setEnabled", () => {
    it("persists the new value and updates every hook instance", async () => {
      const { useKeyboardShortcutsEnabled } =
        await import("@/lib/hooks/useKeyboardShortcutsEnabled");
      const { result: first } = renderHook(() => useKeyboardShortcutsEnabled());
      const { result: second } = renderHook(() => useKeyboardShortcutsEnabled());

      act(() => {
        first.current.setEnabled(false);
      });

      expect(localStorageMock.setItem).toHaveBeenCalledWith(STORAGE_KEY, "false");
      expect(first.current.enabled).toBe(false);
      expect(second.current.enabled).toBe(false);
    });

    it("returns a stable setEnabled across renders", async () => {
      const { useKeyboardShortcutsEnabled } =
        await import("@/lib/hooks/useKeyboardShortcutsEnabled");
      const { result, rerender } = renderHook(() => useKeyboardShortcutsEnabled());

      const firstSetEnabled = result.current.setEnabled;
      rerender();

      expect(result.current.setEnabled).toBe(firstSetEnabled);
    });
  });

  describe("hydration", () => {
    it("renders the same markup on the server and on the first client render when disabled", async () => {
      localStorageMock.setItem(STORAGE_KEY, "false");

      const { useKeyboardShortcutsEnabled } =
        await import("@/lib/hooks/useKeyboardShortcutsEnabled");

      // Mirrors KeyboardShortcutsSettings: an attribute AND a conditional node.
      function Probe() {
        const { enabled } = useKeyboardShortcutsEnabled();
        return (
          <button type="button" role="switch" aria-checked={enabled}>
            {enabled && <kbd>?</kbd>}
          </button>
        );
      }

      // The real server has no localStorage, so the server render must produce
      // the default (enabled) regardless of what the browser has stored.
      const serverHtml = renderToString(<Probe />);
      expect(serverHtml).toContain('aria-checked="true"');
      expect(serverHtml).toContain("<kbd>?</kbd>");

      const container = document.createElement("div");
      container.innerHTML = serverHtml;
      document.body.appendChild(container);

      const recoverableErrors: unknown[] = [];
      let root: ReturnType<typeof hydrateRoot> | undefined;
      await reactAct(async () => {
        root = hydrateRoot(container, <Probe />, {
          onRecoverableError: (error) => {
            recoverableErrors.push(error);
          },
        });
      });

      // A hydration mismatch would be reported here.
      expect(recoverableErrors).toEqual([]);

      // After hydration the client switches to the stored value.
      expect(container.querySelector("kbd")).toBeNull();
      expect(container.querySelector("button")?.getAttribute("aria-checked")).toBe("false");

      await reactAct(async () => {
        root?.unmount();
      });
      container.remove();
    });
  });
});
