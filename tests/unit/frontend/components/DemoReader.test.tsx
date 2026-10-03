/**
 * @vitest-environment jsdom
 */

/**
 * The public demo is the app's own reader tree driven by the in-memory demo
 * store (issue #1524). This renders that tree — `UnifiedEntriesContent` and
 * `Sidebar` — through the real tRPC client with the store's handlers, mounted
 * under `/demo`, and checks the pieces that make it a working demo:
 *   - the welcome article opens from `?entry=` with its demo-only sign-up slot,
 *   - the article auto-marks read through the real mutation and the store,
 *   - starring updates the sidebar count through the real cache updates,
 *   - the entry list links carry the `/demo` prefix,
 *   - the list-level shortcuts (Shift+A, Shift+J/Shift+K) act on this tree.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, fireEvent, within } from "@testing-library/react";
import { UnifiedEntriesContent } from "@/components/entries/UnifiedEntriesContent";
import { Sidebar } from "@/components/layout/Sidebar";
import { AppearanceProvider } from "@/lib/appearance/AppearanceProvider";
import { KeyboardShortcutsProvider } from "@/components/keyboard/KeyboardShortcutsProvider";
import { EntryContentOptionsProvider } from "@/components/entries/EntryContentOptions";
import { AppLocationProvider } from "@/lib/hooks/useAppLocation";
import { createDemoStore } from "@/app/(public)/demo/store";
import { demoEntrySlots } from "@/app/(public)/demo/DemoEntrySlots";
import { DEMO_ENTRIES } from "@/app/(public)/demo/data";
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

const demoTree = () => (
  <>
    <Sidebar />
    <UnifiedEntriesContent />
  </>
);

function renderDemo() {
  const store = createDemoStore();
  const result = renderWithTrpc(demoTree(), {
    handlers: store.handlers,
    wrapper: (children) => (
      <AppLocationProvider basePath="/demo">
        <EntryContentOptionsProvider value={{ renderSlots: demoEntrySlots }}>
          <AppearanceProvider>
            <KeyboardShortcutsProvider>{children}</KeyboardShortcutsProvider>
          </AppearanceProvider>
        </EntryContentOptionsProvider>
      </AppLocationProvider>
    ),
  });
  // The pathname is mocked, so client navigation (pushState) has to be fed
  // back in by hand.
  const followNavigation = () => {
    mockPathname = window.location.pathname;
    result.rerender(demoTree());
  };
  return { ...result, store, followNavigation };
}

const STARRED = DEMO_ENTRIES.filter((e) => e.starred).length;

describe("demo reader tree", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stubMemoryLocalStorage();
    mockPathname = "/demo/all";
    mockSearch = "";
    Element.prototype.scrollIntoView = vi.fn();
  });

  it("lists the demo articles with /demo-prefixed entry links", async () => {
    renderDemo();

    const welcome = await screen.findByRole("link", { name: "Welcome to Lion Reader" });
    expect(welcome).toHaveAttribute("href", "/demo/all?entry=welcome");
    // Sidebar counts come from the store through entries.count.
    const allItems = screen.getByRole("link", { name: /^All Items/ });
    expect(allItems).toHaveAttribute("href", "/demo/all");
    expect(await within(allItems).findByText(`(${DEMO_ENTRIES.length})`)).toBeVisible();
  });

  it("opens the welcome article from ?entry= with its sign-up call to action", async () => {
    mockSearch = "entry=welcome";
    const { callsFor } = renderDemo();

    // Level 1: the (CSS-hidden) list under the article also has the title in an h3.
    expect(
      await screen.findByRole("heading", { name: "Welcome to Lion Reader", level: 1 })
    ).toBeVisible();
    expect(screen.getByRole("heading", { name: "Get Started" })).toBeVisible();
    expect(screen.getByRole("link", { name: "Sign Up" })).toHaveAttribute("href", "/register");
    // The canned-summary button is on offer (summarization.isAvailable → true).
    expect(screen.getByRole("button", { name: "Generate AI summary" })).toBeVisible();

    // The reader's auto-mark-read ran against the store.
    await vi.waitFor(() => expect(callsFor("entries.markRead")).toHaveLength(1));
    expect(callsFor("entries.markRead")[0].input).toMatchObject({
      entries: [{ id: "welcome" }],
      read: true,
    });
  });

  it("shows the canned summary through the real summarize flow", async () => {
    mockSearch = "entry=welcome";
    renderDemo();

    const welcome = DEMO_ENTRIES.find((entry) => entry.id === "welcome")!;
    const summary = new DOMParser().parseFromString(welcome.summaryHtml, "text/html").body
      .textContent!;
    fireEvent.click(await screen.findByRole("button", { name: "Generate AI summary" }));
    expect(
      await screen.findByText((_, element) => element?.textContent === summary, {
        selector: "p",
      })
    ).toBeVisible();
  });

  it("starring an article in the list updates the sidebar's Starred count", async () => {
    renderDemo();

    // Any unstarred row on the first page will do.
    const rows = await screen.findAllByRole("button", { name: /^Unread article:/ });
    const row = rows.find((r) => within(r).queryByRole("button", { name: "Add to starred" }))!;
    const starred = screen.getByRole("link", { name: /^Starred/ });
    expect(await within(starred).findByText(`(${STARRED})`)).toBeVisible();

    fireEvent.click(within(row).getByRole("button", { name: "Add to starred" }));
    expect(await within(starred).findByText(`(${STARRED + 1})`)).toBeVisible();
    expect(within(row).getByRole("button", { name: "Remove from starred" })).toBeVisible();
  });

  it("Shift+J / Shift+K walk the visible sidebar feeds, continuing past one just marked read", async () => {
    mockPathname = "/demo/tag/features";
    window.history.replaceState(null, "", mockPathname);
    const { followNavigation, callsFor } = renderDemo();
    const press = (key: "J" | "K" | "A") => {
      fireEvent.keyDown(document, { key, code: `Key${key}`, shiftKey: true });
      followNavigation();
    };

    const features = await screen.findByRole("link", { name: /^Features/ });
    expect(features).toHaveAttribute("aria-current", "page");
    fireEvent.click(within(features.parentElement!).getByRole("button", { name: "Expand" }));
    await screen.findByRole("link", { name: /^Feed Types/ });

    press("K");
    expect(window.location.pathname).toBe("/demo/tag/about");
    // About is collapsed, so its subscription is skipped.
    press("J");
    expect(window.location.pathname).toBe("/demo/tag/features");
    press("J");
    expect(window.location.pathname).toBe("/demo/subscription/feed-types");

    // Marking the feed read drops it from the unread-only sidebar.
    press("A");
    fireEvent.click(await screen.findByRole("button", { name: "Mark All Read" }));
    await vi.waitFor(() =>
      expect(screen.queryByRole("link", { name: /^Feed Types/ })).not.toBeInTheDocument()
    );
    expect(callsFor("entries.markAllRead")).toHaveLength(1);

    press("J");
    expect(window.location.pathname).toBe("/demo/subscription/reading-experience");
  });
});
