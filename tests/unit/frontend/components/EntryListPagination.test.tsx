/**
 * @vitest-environment jsdom
 */

/**
 * Pagination triggering in the reader tree.
 *
 * Opening an entry within `PAGINATION_THRESHOLD` of the end of the loaded
 * pages must fetch the next page exactly **once**. `EntryListContainer` owns
 * that effect; a second copy in its parent (`UnifiedEntriesContent`) over the
 * same query key would fire in the same commit — React Query's `fetchNextPage`
 * defaults to `cancelRefetch: true`, so the second call cancels and restarts
 * the first, costing a wasted round trip (and a second snapshot/reconcile) per
 * pagination trigger.
 *
 * The check is on the recorded tRPC operations, which include cancelled ones:
 * a duplicate trigger shows up as two `entries.list` calls for the same page.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen } from "@testing-library/react";
import { UnifiedEntriesContent } from "@/components/entries/UnifiedEntriesContent";
import { AppearanceProvider } from "@/lib/appearance/AppearanceProvider";
import { KeyboardShortcutsProvider } from "@/components/keyboard/KeyboardShortcutsProvider";
import { EntryContentOptionsProvider } from "@/components/entries/EntryContentOptions";
import { AppLocationProvider } from "@/lib/hooks/useAppLocation";
import { createDemoStore } from "@/app/(public)/demo/store";
import { renderWithTrpc, stubMemoryLocalStorage } from "../../../utils/component-test-helpers";

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

let mockPathname = "/demo/all";
let mockSearch = "";
vi.mock("next/navigation", () => ({
  usePathname: () => mockPathname,
  useSearchParams: () => new URLSearchParams(mockSearch),
}));

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

/** Entry ids currently rendered in the list, in order. */
function renderedEntryIds(): string[] {
  return screen
    .getAllByRole("link")
    .map((el) => el.getAttribute("href") ?? "")
    .map((href) => /[?&]entry=([^&]+)/.exec(href)?.[1])
    .filter((id): id is string => id !== undefined);
}

describe("entry list pagination", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stubMemoryLocalStorage();
    mockPathname = "/demo/all";
    mockSearch = "";
  });

  it("fetches the next page exactly once when an entry near the end is opened", async () => {
    const { callsFor, rerender } = renderReader();

    // First page loaded.
    await vi.waitFor(() => expect(renderedEntryIds().length).toBeGreaterThan(1));
    const ids = renderedEntryIds();
    expect(callsFor("entries.list")).toHaveLength(1);

    // Open the second-to-last loaded entry: distanceToEnd = 1, inside the
    // 3-entry pagination threshold, so the next page is requested.
    mockSearch = `entry=${ids[ids.length - 2]}`;
    rerender(<UnifiedEntriesContent />);

    await vi.waitFor(() => expect(callsFor("entries.list").length).toBeGreaterThan(1));
    // Exactly one next-page fetch — not one per copy of the effect.
    expect(callsFor("entries.list")).toHaveLength(2);
  });
});
