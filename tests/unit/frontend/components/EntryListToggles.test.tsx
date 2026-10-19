/**
 * @vitest-environment jsdom
 */

/**
 * The list's `m`/`s` shortcuts flip the selected entry's read/starred state:
 * the list hands over the current state, and the request carries its opposite.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent } from "@testing-library/react";
import { UnifiedEntriesContent } from "@/components/entries/UnifiedEntriesContent";
import { AppearanceProvider } from "@/lib/appearance/AppearanceProvider";
import { KeyboardShortcutsProvider } from "@/components/keyboard/KeyboardShortcutsProvider";
import { EntryContentOptionsProvider } from "@/components/entries/EntryContentOptions";
import { AppLocationProvider } from "@/lib/hooks/useAppLocation";
import { getLocalDb } from "@/lib/local-db/local-db";
import { createDemoStore } from "@/lib/demo/store";
import { renderWithTrpc, stubMemoryLocalStorage } from "../../../utils/component-test-helpers";

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

vi.mock("next/navigation", () => ({
  usePathname: () => "/demo/all",
  useSearchParams: () => new URLSearchParams(),
}));

const press = (key: string) =>
  fireEvent.keyDown(document.body, { key, code: `Key${key.toUpperCase()}` });

describe("entry list read/star shortcuts", () => {
  beforeEach(() => {
    stubMemoryLocalStorage();
    Element.prototype.scrollIntoView = vi.fn();
  });

  it("sends the opposite of the selected entry's read and starred state", async () => {
    const { queryClient, callsFor } = renderWithTrpc(<UnifiedEntriesContent />, {
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
    const firstId = await vi.waitFor(() => {
      const id = document.querySelector("[data-entry-id]")?.getAttribute("data-entry-id");
      expect(id).toBeTruthy();
      return id!;
    });
    const before = getLocalDb(queryClient).entries.collection.get(firstId)!;

    press("j");
    press("m");
    press("s");

    await vi.waitFor(() => {
      expect(callsFor("entries.markRead").map((c) => c.input)).toEqual([
        { entries: [{ id: firstId, changedAt: expect.any(Date) }], read: !before.read },
      ]);
      expect(callsFor("entries.setStarred").map((c) => c.input)).toEqual([
        { id: firstId, starred: !before.starred, changedAt: expect.any(Date) },
      ]);
    });
  });
});
