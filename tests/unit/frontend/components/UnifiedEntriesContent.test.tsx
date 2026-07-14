/**
 * @vitest-environment jsdom
 */

/**
 * Component integration tests for UnifiedEntriesContent's not-found guards.
 *
 * Subscription and tag views must distinguish a *genuinely missing* resource
 * (show a NotFoundCard) from a *transient* fetch failure (surface a retryable
 * error via the ErrorBoundary) — see issue #937. These tests drive the real
 * tRPC wiring through the mock-link harness and assert:
 *   - subscriptions.get throwing NOT_FOUND -> "Subscription not found",
 *   - subscriptions.get throwing a non-NOT_FOUND error -> ErrorBoundary (not
 *     the misleading "not found" message),
 *   - tags.list loading without the tag -> "Tag not found",
 *   - tags.list failing -> ErrorBoundary (not "Tag not found").
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen } from "@testing-library/react";
import { TRPCClientError } from "@trpc/client";
import { UnifiedEntriesContent } from "@/components/entries/UnifiedEntriesContent";
import { AppearanceProvider } from "@/lib/appearance/AppearanceProvider";
import { KeyboardShortcutsProvider } from "@/components/keyboard/KeyboardShortcutsProvider";
import {
  renderWithTrpc,
  stubMemoryLocalStorage,
  type ProcedureHandlers,
} from "../../../utils/component-test-helpers";

/**
 * The validation queries only error *after* an async tick, so on first render
 * the full entry-list subtree mounts briefly; it reads appearance/keyboard
 * context, so both providers must wrap the render.
 */
function renderUnified(handlers: ProcedureHandlers) {
  return renderWithTrpc(<UnifiedEntriesContent />, {
    handlers,
    wrapper: (children) => (
      <AppearanceProvider>
        <KeyboardShortcutsProvider>{children}</KeyboardShortcutsProvider>
      </AppearanceProvider>
    ),
  });
}

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

// UnifiedEntriesContent derives its route (and view preferences) from the URL
// via next/navigation. Point it at a specific pathname per test.
const mockPathname = vi.fn(() => "/all");
vi.mock("next/navigation", () => ({
  usePathname: () => mockPathname(),
  useSearchParams: () => new URLSearchParams(),
}));

/** A tRPC error carrying `data.code`, as the real client would surface it. */
function trpcError(code: string, message: string): TRPCClientError<never> {
  return new TRPCClientError(message, {
    result: { error: { data: { code } } },
  } as never);
}

/** entries.list fires unconditionally on mount; give it an empty page. */
function baseHandlers(overrides: ProcedureHandlers = {}): ProcedureHandlers {
  return {
    "entries.list": () => ({ items: [], nextCursor: undefined }),
    ...overrides,
  };
}

describe("UnifiedEntriesContent not-found guards", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stubMemoryLocalStorage();
    mockPathname.mockReturnValue("/all");
  });

  it("shows 'Subscription not found' when subscriptions.get throws NOT_FOUND", async () => {
    mockPathname.mockReturnValue("/subscription/sub-1");
    renderUnified(
      baseHandlers({
        "subscriptions.get": () => {
          throw trpcError("NOT_FOUND", "Subscription not found");
        },
      })
    );

    expect(await screen.findByText("Subscription not found")).toBeInTheDocument();
  });

  it("renders the feed's site link beneath the title when subscriptions.get returns a siteUrl", async () => {
    mockPathname.mockReturnValue("/subscription/sub-1");
    renderUnified(
      baseHandlers({
        "subscriptions.get": () => ({
          id: "sub-1",
          type: "web" as const,
          url: "https://announcements.lionreader.com/changelog.xml",
          title: "Lion Reader Announcements",
          originalTitle: "Lion Reader Announcements",
          description: null,
          siteUrl: "https://announcements.lionreader.com/",
          subscribedAt: new Date(),
          unreadCount: 0,
          tags: [],
          fetchFullContent: false,
        }),
      })
    );

    const link = await screen.findByRole("link", { name: /announcements\.lionreader\.com/ });
    expect(link).toHaveAttribute("href", "https://announcements.lionreader.com/");
  });

  it("surfaces a transient subscriptions.get error to the ErrorBoundary, not a not-found message", async () => {
    mockPathname.mockReturnValue("/subscription/sub-1");
    renderUnified(
      baseHandlers({
        "subscriptions.get": () => {
          throw trpcError("INTERNAL_SERVER_ERROR", "boom");
        },
      })
    );

    // Retryable error UI, not the misleading "not found" card.
    expect(await screen.findByText("Failed to load entries")).toBeInTheDocument();
    expect(screen.queryByText("Subscription not found")).not.toBeInTheDocument();
  });

  it("shows 'Tag not found' when tags.list loads without the requested tag", async () => {
    mockPathname.mockReturnValue("/tag/tag-missing");
    renderUnified(
      baseHandlers({
        "tags.list": () => ({
          items: [{ id: "tag-other", name: "Other", color: "#fff", feedCount: 0, unreadCount: 0 }],
          uncategorized: { feedCount: 0, unreadCount: 0 },
        }),
      })
    );

    expect(await screen.findByText("Tag not found")).toBeInTheDocument();
  });

  it("surfaces a transient tags.list error to the ErrorBoundary, not a not-found message", async () => {
    mockPathname.mockReturnValue("/tag/tag-1");
    renderUnified(
      baseHandlers({
        "tags.list": () => {
          throw trpcError("INTERNAL_SERVER_ERROR", "boom");
        },
      })
    );

    expect(await screen.findByText("Failed to load entries")).toBeInTheDocument();
    expect(screen.queryByText("Tag not found")).not.toBeInTheDocument();
  });
});
