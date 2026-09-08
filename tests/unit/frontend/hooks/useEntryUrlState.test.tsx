/**
 * @vitest-environment jsdom
 */

/**
 * Opening an entry pushes a history entry; closing it must pop that entry, not
 * replace it — otherwise the pushed entry is stranded and the user's next
 * browser Back press appears to do nothing.
 *
 * The hook is instantiated per component and the instance that opens an entry
 * (the list) is not the one that closes it (the reader), so these tests drive
 * two independent instances the way the app does.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

let mockPathname = "/all";
let mockSearch = "";
vi.mock("next/navigation", () => ({
  usePathname: () => mockPathname,
  useSearchParams: () => new URLSearchParams(mockSearch),
}));

const { useEntryUrlState } = await import("@/lib/hooks/useEntryUrlState");

beforeEach(() => {
  mockPathname = "/all";
  mockSearch = "";
  window.history.replaceState(null, "", "/all");
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** Points the mocked location at `search` and re-runs the given hook renders. */
function navigate(search: string, ...rerenders: Array<() => void>): void {
  mockSearch = search;
  for (const rerender of rerenders) act(() => rerender());
}

describe("useEntryUrlState", () => {
  it("pops the pushed history entry when a different instance closes the entry", () => {
    const back = vi.spyOn(window.history, "back").mockImplementation(() => {});
    // Two instances, as in the app: the list opens, the reader closes.
    const list = renderHook(() => useEntryUrlState());
    const reader = renderHook(() => useEntryUrlState());

    act(() => list.result.current.setOpenEntryId("entry-1"));
    expect(window.location.search).toBe("?entry=entry-1");
    navigate("entry=entry-1", list.rerender, reader.rerender);

    const replaceState = vi.spyOn(window.history, "replaceState");
    act(() => reader.result.current.closeEntry());

    expect(back).toHaveBeenCalledTimes(1);
    expect(replaceState).not.toHaveBeenCalled();
  });

  it("marks the history entry it pushes when opening from the list", () => {
    const { result } = renderHook(() => useEntryUrlState());

    act(() => result.current.setOpenEntryId("entry-1"));

    expect(window.history.state).toMatchObject({ entryOpened: true });
  });

  it("keeps the marker across entry-to-entry navigation, which replaces", () => {
    const back = vi.spyOn(window.history, "back").mockImplementation(() => {});
    const { result, rerender } = renderHook(() => useEntryUrlState());
    const lengthBeforeOpen = window.history.length;

    act(() => result.current.setOpenEntryId("entry-1"));
    navigate("entry=entry-1", rerender);
    act(() => result.current.setOpenEntryId("entry-2"));
    navigate("entry=entry-2", rerender);

    expect(window.location.search).toBe("?entry=entry-2");
    // Swiping between entries replaces rather than pushing, so exactly one
    // history entry was added by the open.
    expect(window.history.length).toBe(lengthBeforeOpen + 1);

    act(() => result.current.closeEntry());
    expect(back).toHaveBeenCalledTimes(1);
  });

  it("replaces instead of popping when nothing was pushed (deep link into an entry)", () => {
    // Landing directly on ?entry=… : going back would leave the app entirely.
    mockSearch = "entry=entry-1";
    window.history.replaceState(null, "", "/all?entry=entry-1");
    const back = vi.spyOn(window.history, "back").mockImplementation(() => {});
    const { result } = renderHook(() => useEntryUrlState());

    act(() => result.current.closeEntry());

    expect(back).not.toHaveBeenCalled();
    expect(window.location.search).toBe("");
  });

  it("preserves the other query params when opening and closing", () => {
    mockPathname = "/all";
    mockSearch = "unread=false";
    window.history.replaceState(null, "", "/all?unread=false");
    const { result, rerender } = renderHook(() => useEntryUrlState());

    act(() => result.current.setOpenEntryId("entry-1"));
    expect(window.location.search).toBe("?unread=false&entry=entry-1");

    navigate("unread=false&entry=entry-1", rerender);
    expect(result.current.openEntryId).toBe("entry-1");
    expect(result.current.entryHref("entry-2")).toBe("/all?unread=false&entry=entry-2");
  });
});
