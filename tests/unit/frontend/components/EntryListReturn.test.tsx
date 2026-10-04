/**
 * @vitest-environment jsdom
 */

/**
 * Closing an entry puts the list's j/k selection (the focused row) back on
 * it — or, when the entry left the collection being viewed while open, on
 * its nearest neighbour still listed.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { act } from "@testing-library/react";
import { UnifiedEntriesContent } from "@/components/entries/UnifiedEntriesContent";
import { AppearanceProvider } from "@/lib/appearance/AppearanceProvider";
import { KeyboardShortcutsProvider } from "@/components/keyboard/KeyboardShortcutsProvider";
import { EntryContentOptionsProvider } from "@/components/entries/EntryContentOptions";
import { AppLocationProvider } from "@/lib/hooks/useAppLocation";
import { applyCollectionEntriesChange } from "@/lib/cache/operations";
import { createDemoStore } from "@/app/(public)/demo/store";
import { renderWithTrpc, stubMemoryLocalStorage } from "../../../utils/component-test-helpers";
import { createRealTrpcUtils } from "../../../utils/cache-test-helpers";

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

let mockPathname = "";
let mockSearch = "";
vi.mock("next/navigation", () => ({
  usePathname: () => mockPathname,
  useSearchParams: () => new URLSearchParams(mockSearch),
}));

/** A collection of three demo entries, open in the reader's list. */
function renderCollection() {
  const store = createDemoStore();
  const { subscription } = store.procedures["collections.create"]({ name: "Collection" });
  const entryIds = store.procedures["entries.list"]({ limit: 3 }).items.map((e) => e.id);
  store.procedures["collections.addEntries"]({ id: subscription.id, entryIds });
  mockPathname = `/demo/subscription/${subscription.id}`;
  const rendered = renderWithTrpc(<UnifiedEntriesContent />, {
    handlers: store.handlers,
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
  const setOpenEntry = (id: string | null, pathname = mockPathname) => {
    mockSearch = id ? `entry=${id}` : "";
    mockPathname = pathname;
    rendered.rerender(<UnifiedEntriesContent />);
  };
  const removeFromCollection = (entryId: string) => {
    const result = store.procedures["collections.removeEntries"]({
      id: subscription.id,
      entryIds: [entryId],
    });
    act(() =>
      applyCollectionEntriesChange(
        createRealTrpcUtils(rendered.queryClient),
        rendered.queryClient,
        {
          subscriptionId: subscription.id,
          entryIds: result.entryIds,
          added: false,
          counts: result.counts,
        }
      )
    );
  };
  const listedIds = () =>
    [...document.querySelectorAll("[data-entry-id]")].map((el) => el.getAttribute("data-entry-id"));
  const focusedId = () => document.activeElement?.getAttribute("data-entry-id") ?? null;
  return { entryIds, setOpenEntry, removeFromCollection, listedIds, focusedId };
}

describe("returning from an entry to the list", () => {
  beforeEach(() => {
    stubMemoryLocalStorage();
    mockSearch = "";
    Element.prototype.scrollIntoView = vi.fn();
  });

  it("selects the closed entry", async () => {
    const { entryIds, setOpenEntry, listedIds, focusedId } = renderCollection();
    await vi.waitFor(() => expect(listedIds()).toEqual(entryIds));

    setOpenEntry(entryIds[1]);
    setOpenEntry(null);

    expect(focusedId()).toBe(entryIds[1]);
  });

  it("selects the next entry when the closed one left the collection", async () => {
    const { entryIds, setOpenEntry, removeFromCollection, listedIds, focusedId } =
      renderCollection();
    await vi.waitFor(() => expect(listedIds()).toEqual(entryIds));

    setOpenEntry(entryIds[1]);
    removeFromCollection(entryIds[1]);
    setOpenEntry(null);

    expect(listedIds()).toEqual([entryIds[0], entryIds[2]]);
    expect(focusedId()).toBe(entryIds[2]);
  });

  it("selects the previous entry when the removed one was last", async () => {
    const { entryIds, setOpenEntry, removeFromCollection, listedIds, focusedId } =
      renderCollection();
    await vi.waitFor(() => expect(listedIds()).toEqual(entryIds));

    setOpenEntry(entryIds[2]);
    removeFromCollection(entryIds[2]);
    setOpenEntry(null);

    expect(focusedId()).toBe(entryIds[1]);
  });

  it("leaves the selection alone when leaving the entry for another view", async () => {
    // The new view starts at the top; a row from the old view's position
    // would be an arbitrary, off-screen selection.
    const { entryIds, setOpenEntry, listedIds, focusedId } = renderCollection();
    const collectionPath = mockPathname;
    await vi.waitFor(() => expect(listedIds()).toEqual(entryIds));
    // Load the other view first, so it renders straight from cache.
    setOpenEntry(null, "/demo/all");
    await vi.waitFor(() => expect(listedIds().length).toBeGreaterThan(entryIds.length));
    setOpenEntry(null, collectionPath);
    await vi.waitFor(() => expect(listedIds()).toEqual(entryIds));

    setOpenEntry(entryIds[1]);
    setOpenEntry(null, "/demo/all");
    expect(listedIds().length).toBeGreaterThan(entryIds.length);

    expect(focusedId()).toBeNull();
  });
});
