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
import { renderHook, act, fireEvent, screen } from "@testing-library/react";
import { UnifiedEntriesContent } from "@/components/entries/UnifiedEntriesContent";
import { EntryContentOptionsProvider } from "@/components/entries/EntryContentOptions";
import { KeyboardShortcutsProvider } from "@/components/keyboard/KeyboardShortcutsProvider";
import { AppearanceProvider } from "@/lib/appearance/AppearanceProvider";
import { AppLocationProvider } from "@/lib/hooks/useAppLocation";
import { createDemoStore } from "@/app/(public)/demo/store";
import { renderWithTrpc, stubMemoryLocalStorage } from "../../../utils/component-test-helpers";

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

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

  it("re-opens an entry after Back when pushState mutates the state it is given", () => {
    // Next's patched pushState copies its internal `__NA` key from the current
    // history entry *onto the object it is handed*, and skips the router sync
    // (the part that updates usePathname/useSearchParams) for any object that
    // already carries it. Mirror that, with every entry Next-managed (so `__NA`
    // is set, as in the app), and count the syncs: open → back → open must sync
    // twice. A shared state object gets `__NA` on the first open and is then
    // mistaken for an internal call on the second.
    let routerSyncs = 0;
    const originalPushState = window.history.pushState.bind(window.history);
    vi.spyOn(window.history, "pushState").mockImplementation((data, unused, url) => {
      if (data?.__NA) return originalPushState(data, unused, url);
      data = data ?? {};
      if (window.history.state?.__NA) data.__NA = true;
      routerSyncs++;
      return originalPushState(data, unused, url);
    });
    window.history.replaceState({ __NA: true }, "", "/all");
    const { result, rerender } = renderHook(() => useEntryUrlState());

    act(() => result.current.setOpenEntryId("entry-1"));
    expect(routerSyncs).toBe(1);

    // Browser Back restores the list's entry, which Next had stamped too.
    window.history.replaceState({ __NA: true }, "", "/all");
    navigate("", rerender);

    act(() => result.current.setOpenEntryId("entry-1"));
    expect(routerSyncs).toBe(2);
    expect(window.location.search).toBe("?entry=entry-1");
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

/**
 * Escape-to-close must go through the same `closeEntry` the reader's back
 * affordance uses, or it replaces the pushed history entry instead of popping
 * it and the user's next Back press looks like a no-op again (#1571). The
 * wiring lives in `EntryListContainer`, so this drives the real reader tree
 * (as the demo does) and presses the key.
 */
describe("Escape closes the entry through closeEntry", () => {
  beforeEach(() => {
    stubMemoryLocalStorage();
    mockPathname = "/demo/all";
  });

  function renderReader() {
    const store = createDemoStore();
    return renderWithTrpc(<UnifiedEntriesContent />, {
      handlers: store.handlers,
      wrapper: (children) => (
        <AppLocationProvider basePath="/demo">
          <EntryContentOptionsProvider value={{ hideNarration: true }}>
            <AppearanceProvider>
              <KeyboardShortcutsProvider>{children}</KeyboardShortcutsProvider>
            </AppearanceProvider>
          </EntryContentOptionsProvider>
        </AppLocationProvider>
      ),
    });
  }

  it("pops the history entry that opening pushed", async () => {
    window.history.replaceState(null, "", "/demo/all");
    const { rerender } = renderReader();

    // Open the article the way a click does, then let the mocked location catch up.
    fireEvent.click(await screen.findByRole("link", { name: "Welcome to Lion Reader" }));
    expect(window.history.state).toMatchObject({ entryOpened: true });
    mockSearch = "entry=welcome";
    rerender(<UnifiedEntriesContent />);
    expect(
      await screen.findByRole("heading", { name: "Welcome to Lion Reader", level: 1 })
    ).toBeVisible();

    const back = vi.spyOn(window.history, "back").mockImplementation(() => {});
    const replaceState = vi.spyOn(window.history, "replaceState");
    fireEvent.keyDown(document, { key: "Escape", code: "Escape" });

    expect(back).toHaveBeenCalledTimes(1);
    expect(replaceState).not.toHaveBeenCalled();
  });
});
