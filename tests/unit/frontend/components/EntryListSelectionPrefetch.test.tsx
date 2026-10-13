/**
 * @vitest-environment jsdom
 */

/**
 * Moving the list's j/k selection prefetches the selected entry, the keyboard
 * counterpart of the mousedown prefetch, so opening it renders from cache.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent } from "@testing-library/react";
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

vi.mock("next/navigation", () => ({
  usePathname: () => "/demo/all",
  useSearchParams: () => new URLSearchParams(),
}));

describe("entry list selection prefetch", () => {
  beforeEach(() => {
    stubMemoryLocalStorage();
    Element.prototype.scrollIntoView = vi.fn();
  });

  it("prefetches the entry j selects, unbatched", async () => {
    const store = createDemoStore();
    const { callsFor } = renderWithTrpc(<UnifiedEntriesContent />, {
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
    const listed = () =>
      [...document.querySelectorAll("[data-entry-id]")].map((el) =>
        el.getAttribute("data-entry-id")
      );
    await vi.waitFor(() => expect(listed().length).toBeGreaterThan(1));
    expect(callsFor("entries.get")).toEqual([]);

    fireEvent.keyDown(document.body, { key: "j", code: "KeyJ" });
    fireEvent.keyDown(document.body, { key: "j", code: "KeyJ" });

    await vi.waitFor(() =>
      expect(
        callsFor("entries.get").map((c) => [(c.input as { id: string }).id, c.context.skipBatch])
      ).toEqual([[listed()[1], true]])
    );
  });
});
