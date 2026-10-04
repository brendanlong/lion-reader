/**
 * @vitest-environment jsdom
 */

/**
 * Component integration tests for Sidebar.
 *
 * The Sidebar renders its feed tree from real tRPC queries (`entries.count` for
 * the nav counts, `tags.list` for tag sections, `subscriptions.list` for the
 * feeds inside an expanded section) and owns the `subscriptions.delete`
 * mutation behind the unsubscribe flow. These tests drive the real UI through
 * the mock-link harness:
 *   - the tag/feed tree renders from the seeded queries,
 *   - expanding a section loads its subscriptions,
 *   - confirming the unsubscribe dialog fires `subscriptions.delete` and
 *     optimistically removes the feed from the sidebar,
 *   - the open subscription stays listed and only its chosen copy is current,
 *   - a feed the unread-only filter hid appears once counts give it unread entries.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, screen, fireEvent, within } from "@testing-library/react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { TRPCClientError } from "@trpc/client";
import { Sidebar } from "@/components/layout/Sidebar";
import { setEntryRelatedCounts } from "@/lib/cache/operations";
import { trpc, type TRPCClientUtils } from "@/lib/trpc/client";
import { goToSidebarFeed } from "@/components/layout/sidebar-feed-navigation";
import {
  renderWithTrpc,
  stubMemoryLocalStorage,
  type ProcedureHandlers,
} from "../../../utils/component-test-helpers";

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

// Sidebar's children read the current route via next/navigation's usePathname.
const mockPathname = vi.fn(() => "/all");
vi.mock("next/navigation", () => ({
  usePathname: () => mockPathname(),
}));

const TECH_TAG = { id: "tag-1", name: "Tech", color: "#ff0000" };
const FEED_ONE = {
  id: "sub-1",
  type: "web",
  url: "https://example.com/feed1.xml",
  title: "Feed One",
  originalTitle: "Feed One",
  unreadCount: 5,
  tags: [TECH_TAG],
};

/** A tRPC error carrying `data.code`, as the real client would surface it. */
function trpcError(code: string, message: string): TRPCClientError<never> {
  return new TRPCClientError(message, {
    result: { error: { data: { code } } },
  } as never);
}

/**
 * Handlers for the full Sidebar subtree. The default fixture has a single
 * "Tech" tag containing one subscription ("Feed One").
 */
function baseHandlers(overrides: ProcedureHandlers = {}): ProcedureHandlers {
  return {
    "entries.count": (input) => {
      const filter = input as { starredOnly?: boolean; type?: string };
      if (filter.starredOnly) return { unread: 2 };
      if (filter.type === "saved") return { unread: 1 };
      return { unread: 18 };
    },
    "tags.list": () => ({
      items: [{ id: "tag-1", name: "Tech", color: "#ff0000", feedCount: 1, unreadCount: 5 }],
      uncategorized: { feedCount: 0, unreadCount: 0 },
    }),
    "subscriptions.list": () => ({ items: [FEED_ONE], nextCursor: undefined }),
    "subscriptions.delete": () => ({}),
    ...overrides,
  };
}

async function expandTechTag() {
  // Scope to the Tech tag's row (there's also an "Uncategorized" section with
  // its own toggle) and expand it if not already expanded. Idempotent because
  // useExpandedTags keeps its expanded set in a module-level cache that persists
  // across renders within the test file.
  const techLink = await screen.findByRole("link", { name: /Tech/ });
  const li = techLink.closest("li");
  if (!li) throw new Error("Tech tag row not found");
  const toggle = within(li).getByRole("button", { name: /Expand|Collapse/ });
  if (toggle.getAttribute("aria-label") === "Expand") {
    fireEvent.click(toggle);
  }
}

describe("Sidebar", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPathname.mockReturnValue("/all");
    stubMemoryLocalStorage();
  });

  it("renders the nav counts and tag sections from queries", async () => {
    renderWithTrpc(<Sidebar />, { handlers: baseHandlers() });

    // Tag from tags.list.
    expect(await screen.findByText("Tech")).toBeInTheDocument();
    // "All Items" nav count from entries.count (rendered as "(18)").
    expect(await screen.findByText("(18)")).toBeInTheDocument();
  });

  it("loads a section's subscriptions when expanded", async () => {
    renderWithTrpc(<Sidebar />, { handlers: baseHandlers() });

    await expandTechTag();

    expect(await screen.findByText("Feed One")).toBeInTheDocument();
  });

  it("fires subscriptions.delete when the unsubscribe is confirmed", async () => {
    const { callsFor } = renderWithTrpc(<Sidebar />, { handlers: baseHandlers() });

    await expandTechTag();
    await screen.findByText("Feed One");

    // Open the unsubscribe confirmation dialog for the feed.
    fireEvent.click(screen.getByRole("button", { name: "Unsubscribe from Feed One" }));

    // Confirm in the dialog (the confirm button is labelled "Unsubscribe").
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Unsubscribe" }));

    await vi.waitFor(() => {
      const deleteCalls = callsFor("subscriptions.delete");
      expect(deleteCalls).toHaveLength(1);
      expect(deleteCalls[0].input).toEqual({ id: "sub-1" });
    });

    // Optimistic removal: the feed disappears from the sidebar.
    await vi.waitFor(() => {
      expect(screen.queryByText("Feed One")).not.toBeInTheDocument();
    });
  });

  it("drops the open subscription from the sidebar once it's unsubscribed", async () => {
    let deleted = false;
    mockPathname.mockReturnValue("/subscription/sub-1");
    renderWithTrpc(<Sidebar />, {
      handlers: baseHandlers({
        "subscriptions.delete": () => {
          deleted = true;
          return {};
        },
        "subscriptions.get": () => {
          if (deleted) throw trpcError("NOT_FOUND", "Subscription not found");
          return FEED_ONE;
        },
      }),
    });

    await expandTechTag();
    fireEvent.click(await screen.findByRole("button", { name: "Unsubscribe from Feed One" }));
    fireEvent.click(
      within(await screen.findByRole("dialog")).getByRole("button", { name: "Unsubscribe" })
    );

    await vi.waitFor(() => expect(screen.queryByText("Feed One")).not.toBeInTheDocument());
  });

  it("does not delete when the unsubscribe dialog is cancelled", async () => {
    const { callsFor } = renderWithTrpc(<Sidebar />, { handlers: baseHandlers() });

    await expandTechTag();
    await screen.findByText("Feed One");

    fireEvent.click(screen.getByRole("button", { name: "Unsubscribe from Feed One" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));

    expect(callsFor("subscriptions.delete")).toHaveLength(0);
    expect(screen.getByText("Feed One")).toBeInTheDocument();
  });

  it("keeps the open subscription and its tag listed after they're read", async () => {
    const readFeed = { ...FEED_ONE, unreadCount: 0 };
    mockPathname.mockReturnValue("/subscription/sub-1");
    renderWithTrpc(<Sidebar />, {
      handlers: baseHandlers({
        "tags.list": () => ({
          items: [{ ...TECH_TAG, feedCount: 1, unreadCount: 0 }],
          uncategorized: { feedCount: 0, unreadCount: 0 },
        }),
        // The server's unread-only filter leaves the read feed out.
        "subscriptions.list": (input) => ({
          items: (input as { unreadOnly?: boolean }).unreadOnly ? [] : [readFeed],
          nextCursor: undefined,
        }),
        "subscriptions.get": () => readFeed,
      }),
    });

    await expandTechTag();
    expect(await screen.findByRole("link", { name: "Feed One" })).toHaveAttribute(
      "aria-current",
      "page"
    );
  });

  it("marks only the chosen copy of a subscription listed under two tags", async () => {
    const newsTag = { id: "tag-2", name: "News", color: null };
    const twoTagFeed = { ...FEED_ONE, tags: [TECH_TAG, newsTag] };
    mockPathname.mockReturnValue("/subscription/sub-1");
    window.history.replaceState(null, "", "/subscription/sub-1");
    Element.prototype.scrollIntoView = vi.fn();
    renderWithTrpc(<Sidebar />, {
      handlers: baseHandlers({
        "tags.list": () => ({
          items: [
            { ...TECH_TAG, feedCount: 1, unreadCount: 5 },
            { ...newsTag, feedCount: 1, unreadCount: 5 },
          ],
          uncategorized: { feedCount: 0, unreadCount: 0 },
        }),
        "subscriptions.list": () => ({ items: [twoTagFeed], nextCursor: undefined }),
        "subscriptions.get": () => twoTagFeed,
      }),
    });
    const newsLink = await screen.findByRole("link", { name: /^News/ });
    fireEvent.click(within(newsLink.closest("li")!).getByRole("button", { name: "Expand" }));
    await expandTechTag();

    // Sidebar order: News, Feed One (News), Tech, Feed One (Tech).
    await vi.waitFor(() =>
      expect(screen.getAllByRole("link", { name: /Feed One/ })).toHaveLength(2)
    );
    const copies = screen.getAllByRole("link", { name: /Feed One/ });
    // Reached by URL, no copy was chosen, so both are current.
    for (const copy of copies) expect(copy).toHaveAttribute("aria-current", "page");

    fireEvent.click(copies[1]);
    expect(copies[0]).not.toHaveAttribute("aria-current");
    expect(copies[1]).toHaveAttribute("aria-current", "page");

    // Shift+K steps back from the chosen (Tech) copy, not the first one.
    goToSidebarFeed(-1);
    expect(window.location.pathname).toBe("/tag/tag-1");

    // With the chosen copy collapsed away, the remaining copy is current again.
    fireEvent.click(
      within(screen.getByRole("link", { name: /^Tech/ }).closest("li")!).getByRole("button", {
        name: "Collapse",
      })
    );
    expect(screen.getByRole("link", { name: /Feed One/ })).toHaveAttribute("aria-current", "page");
    window.history.replaceState(null, "", "/");
  });

  it("lists a feed the unread-only filter hid once counts give it unread entries (#1806)", async () => {
    const picks = { ...FEED_ONE, id: "sub-2", type: "collection", title: "Picks", unreadCount: 1 };
    let caches: { utils: TRPCClientUtils; queryClient: QueryClient } | undefined;
    function CaptureCaches() {
      caches = { utils: trpc.useUtils(), queryClient: useQueryClient() };
      return null;
    }
    const { callsFor } = renderWithTrpc(
      <>
        <Sidebar />
        <CaptureCaches />
      </>,
      { handlers: baseHandlers({ "subscriptions.get": () => picks }) }
    );
    await expandTechTag();
    await screen.findByText("Feed One");
    expect(screen.queryByText("Picks")).not.toBeInTheDocument();

    // An article in the (read, so unlisted) collection was marked unread.
    act(() =>
      setEntryRelatedCounts(
        caches!.utils,
        {
          all: { unread: 19 },
          starred: { unread: 2 },
          subscriptions: [{ id: "sub-2", unread: 1, tagIds: [TECH_TAG.id] }],
          tags: [{ id: TECH_TAG.id, unread: 6 }],
        },
        caches!.queryClient
      )
    );

    expect(await screen.findByRole("link", { name: /^Picks/ })).toHaveTextContent("(1)");
    expect(callsFor("subscriptions.get").map((call) => call.input)).toEqual([{ id: "sub-2" }]);
  });

  it("lists the open, read subscription again when unsubscribing from it fails", async () => {
    const readFeed = { ...FEED_ONE, unreadCount: 0 };
    mockPathname.mockReturnValue("/subscription/sub-1");
    const { callsFor } = renderWithTrpc(<Sidebar />, {
      handlers: baseHandlers({
        // The unread-only filter leaves the read feed out; only being open lists it.
        "subscriptions.list": (input) => ({
          items: (input as { unreadOnly?: boolean }).unreadOnly ? [] : [readFeed],
          nextCursor: undefined,
        }),
        "subscriptions.get": () => readFeed,
        "subscriptions.delete": () => {
          throw trpcError("INTERNAL_SERVER_ERROR", "Database unavailable");
        },
      }),
    });
    await expandTechTag();
    fireEvent.click(await screen.findByRole("button", { name: "Unsubscribe from Feed One" }));
    fireEvent.click(
      within(await screen.findByRole("dialog")).getByRole("button", { name: "Unsubscribe" })
    );

    await vi.waitFor(() => expect(callsFor("subscriptions.delete")).toHaveLength(1));
    expect(await screen.findByRole("link", { name: "Feed One" })).toBeInTheDocument();
  });
});
