/**
 * @vitest-environment jsdom
 */

/**
 * The entry-list shortcuts are one useHotkeys binding dispatched through the
 * shortcut table, so these cover the dispatch itself: per-shortcut enabled
 * conditions, the "g then key" chords and their precedence over the second
 * key's own binding, and the global off switch.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, fireEvent, cleanup, act } from "@testing-library/react";
import {
  PREFIX_TIMEOUT_MS,
  useKeyboardShortcuts,
  type KeyboardEntryData,
  type UseKeyboardShortcutsOptions,
} from "@/lib/hooks/useKeyboardShortcuts";
import { SIDEBAR_FEEDS_ATTRIBUTE } from "@/components/layout/sidebar-feed-navigation";

const ENTRIES: KeyboardEntryData[] = [
  { id: "a", url: "https://example.com/a", read: false, starred: false, type: "web" },
  { id: "b", url: null, read: true, starred: true, type: "web" },
];

function setup(overrides: Partial<UseKeyboardShortcutsOptions> = {}) {
  const options: UseKeyboardShortcutsOptions = {
    entries: ENTRIES,
    onOpenEntry: vi.fn(),
    onClose: vi.fn(),
    openEntryId: null,
    enabled: true,
    onToggleRead: vi.fn(),
    onToggleStar: vi.fn(),
    onRefresh: vi.fn(),
    onToggleUnreadOnly: vi.fn(),
    onNavigateNext: vi.fn(),
    onNavigatePrevious: vi.fn(),
    ...overrides,
  };
  const { result } = renderHook(() => useKeyboardShortcuts(options));
  return { options, result };
}

const press = (key: string, init: KeyboardEventInit = {}) =>
  fireEvent.keyDown(document.body, { key, code: `Key${key.toUpperCase()}`, ...init });

beforeEach(() => {
  window.history.replaceState(null, "", "/");
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("useKeyboardShortcuts", () => {
  it("moves the selection with j/k and acts on the selected entry", () => {
    const { options, result } = setup();

    press("k");
    expect(result.current.selectedEntryId).toBe("b");
    press("j");
    expect(result.current.selectedEntryId).toBe("b");
    press("k");
    expect(result.current.selectedEntryId).toBe("a");

    press("m");
    expect(options.onToggleRead).toHaveBeenCalledWith("a", false);
    press("s");
    expect(options.onToggleStar).toHaveBeenCalledWith("a", false);
    press("o");
    expect(options.onOpenEntry).toHaveBeenCalledWith("a");
  });

  // The dispatcher matches the key names react-hotkeys-hook reports, which
  // for modified and named keys differ from the plain-letter case.
  it("dispatches Enter and Shift-modified alternatives", () => {
    const { options } = setup();
    const sidebar = document.createElement("nav");
    sidebar.setAttribute(SIDEBAR_FEEDS_ATTRIBUTE, "");
    const link = document.createElement("a");
    link.href = "/subscription/1";
    const onFeedClick = vi.fn((e: Event) => e.preventDefault());
    link.addEventListener("click", onFeedClick);
    link.scrollIntoView = vi.fn();
    sidebar.append(link);
    document.body.append(sidebar);
    try {
      press("j");
      fireEvent.keyDown(document.body, { key: "Enter", code: "Enter" });
      expect(options.onOpenEntry).toHaveBeenCalledWith("a");

      press("N", { shiftKey: true, code: "KeyN" });
      expect(onFeedClick).toHaveBeenCalledOnce();
    } finally {
      sidebar.remove();
    }
  });

  it("ignores selection shortcuts with nothing selected", () => {
    const { options } = setup();

    press("m");
    press("s");
    press("o");

    expect(options.onToggleRead).not.toHaveBeenCalled();
    expect(options.onToggleStar).not.toHaveBeenCalled();
    expect(options.onOpenEntry).not.toHaveBeenCalled();
  });

  it("hands j/k/Escape to the reader while an entry is open and disables list actions", () => {
    const { options } = setup({ openEntryId: "a" });

    press("j");
    press("k");
    fireEvent.keyDown(document.body, { key: "Escape", code: "Escape" });
    press("m");
    press("r");

    expect(options.onNavigateNext).toHaveBeenCalledOnce();
    expect(options.onNavigatePrevious).toHaveBeenCalledOnce();
    expect(options.onClose).toHaveBeenCalledOnce();
    expect(options.onToggleRead).not.toHaveBeenCalled();
    expect(options.onRefresh).not.toHaveBeenCalled();
  });

  it("g then s goes to Starred instead of starring the selection", () => {
    const { options } = setup();
    press("j");

    press("g");
    press("s");

    expect(window.location.pathname).toBe("/starred");
    expect(options.onToggleStar).not.toHaveBeenCalled();

    // The chord is used up: a second s stars again.
    press("s");
    expect(options.onToggleStar).toHaveBeenCalledWith("a", false);
  });

  it("a chord's second key does nothing on its own or after the prefix times out", () => {
    vi.useFakeTimers();
    setup();

    press("a");
    expect(window.location.pathname).toBe("/");

    press("g");
    act(() => vi.advanceTimersByTime(PREFIX_TIMEOUT_MS));
    press("a");
    expect(window.location.pathname).toBe("/");

    press("g");
    press("a");
    expect(window.location.pathname).toBe("/all");
  });

  it("does nothing while typing in a form field, behind a dialog, or when shortcuts are disabled", () => {
    const { options } = setup();
    const input = document.createElement("input");
    document.body.appendChild(input);
    fireEvent.keyDown(input, { key: "r", code: "KeyR" });
    input.remove();
    expect(options.onRefresh).not.toHaveBeenCalled();

    const dialog = document.createElement("div");
    dialog.setAttribute("aria-modal", "true");
    document.body.appendChild(dialog);
    press("r");
    dialog.remove();
    expect(options.onRefresh).not.toHaveBeenCalled();

    cleanup();
    const disabled = setup({ enabled: false });
    press("r");
    expect(disabled.options.onRefresh).not.toHaveBeenCalled();
  });
});
