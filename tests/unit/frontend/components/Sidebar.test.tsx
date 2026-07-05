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
 *     optimistically removes the feed from the sidebar.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, fireEvent, within } from "@testing-library/react";
import { Sidebar } from "@/components/layout/Sidebar";
import { renderWithTrpc, type ProcedureHandlers } from "../../../utils/component-test-helpers";

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

// Sidebar's children read the current route via next/navigation's usePathname.
const mockPathname = vi.fn(() => "/all");
vi.mock("next/navigation", () => ({
  usePathname: () => mockPathname(),
}));

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
    "subscriptions.list": () => ({
      items: [
        {
          id: "sub-1",
          type: "web",
          url: "https://example.com/feed1.xml",
          title: "Feed One",
          originalTitle: "Feed One",
          unreadCount: 5,
          tags: [{ id: "tag-1", name: "Tech", color: "#ff0000" }],
        },
      ],
      nextCursor: undefined,
    }),
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
    localStorage.clear();
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
});
