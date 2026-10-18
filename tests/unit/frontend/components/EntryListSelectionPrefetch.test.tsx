/**
 * @vitest-environment jsdom
 */

/**
 * Moving the list's j/k selection prefetches the selected entry, the keyboard
 * counterpart of the mousedown prefetch, so opening it renders from cache.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fireEvent } from "@testing-library/react";
import { UnifiedEntriesContent } from "@/components/entries/UnifiedEntriesContent";
import { AppearanceProvider } from "@/lib/appearance/AppearanceProvider";
import { KeyboardShortcutsProvider } from "@/components/keyboard/KeyboardShortcutsProvider";
import { EntryContentOptionsProvider } from "@/components/entries/EntryContentOptions";
import { AppLocationProvider } from "@/lib/hooks/useAppLocation";
import { createDemoStore } from "@/lib/demo/store";
import { renderWithTrpc, stubMemoryLocalStorage } from "../../../utils/component-test-helpers";

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

let mockSearch = "";
vi.mock("next/navigation", () => ({
  usePathname: () => "/demo/all",
  useSearchParams: () => new URLSearchParams(mockSearch),
}));

function renderList() {
  const rendered = renderWithTrpc(<UnifiedEntriesContent />, {
    handlers: createDemoStore().handlers,
    wrapper: (children) => (
      <AppLocationProvider basePath="/demo">
        <EntryContentOptionsProvider value={{}}>
          <AppearanceProvider>
            <KeyboardShortcutsProvider>{children}</KeyboardShortcutsProvider>
          </AppearanceProvider>
        </EntryContentOptionsProvider>
      </AppLocationProvider>
    ),
  });
  const setOpenEntry = (id: string | null) => {
    mockSearch = id ? `entry=${id}` : "";
    rendered.rerender(<UnifiedEntriesContent />);
  };
  const listed = () =>
    [...document.querySelectorAll("[data-entry-id]")].map((el) => el.getAttribute("data-entry-id"));
  const fetched = () =>
    rendered
      .callsFor("entries.get")
      .map((c) => [(c.input as { id: string }).id, c.context.skipBatch]);
  return { setOpenEntry, listed, fetched };
}

const pressJ = () => fireEvent.keyDown(document.body, { key: "j", code: "KeyJ" });

describe("entry list selection prefetch", () => {
  beforeEach(() => {
    stubMemoryLocalStorage();
    mockSearch = "";
    Element.prototype.scrollIntoView = vi.fn();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("prefetches the entry j selects, unbatched", async () => {
    const { listed, fetched } = renderList();
    await vi.waitFor(() => expect(listed().length).toBeGreaterThan(1));
    expect(fetched()).toEqual([]);

    pressJ();
    pressJ();

    await vi.waitFor(() => expect(fetched()).toEqual([[listed()[1], true]]));
  });

  it("doesn't refetch a cached entry, even a stale one, on selecting it again", async () => {
    const { setOpenEntry, listed, fetched } = renderList();
    await vi.waitFor(() => expect(listed().length).toBeGreaterThan(1));
    const entryId = listed()[0]!;
    setOpenEntry(entryId);
    await vi.waitFor(() => expect(fetched().some(([id]) => id === entryId)).toBe(true));
    const fetchesWhileOpen = fetched().length;

    // Long past the query's staleTime by the time the reader closes it.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 60 * 60 * 1000);
    setOpenEntry(null);
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(fetched()).toHaveLength(fetchesWhileOpen);
  });
});
