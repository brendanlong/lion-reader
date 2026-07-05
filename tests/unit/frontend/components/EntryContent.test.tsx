/**
 * @vitest-environment jsdom
 */

/**
 * Component integration tests for EntryContent.
 *
 * EntryContent fetches a single entry via `entries.get` (non-suspending query
 * with an inline fallback) and auto-marks it read on mount. These tests drive
 * the real tRPC wiring through the mock-link harness:
 *   - the entry title/content render from the `entries.get` response,
 *   - the entry is auto-marked read via `entries.markRead`,
 *   - a query error surfaces via the ErrorBoundary.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen } from "@testing-library/react";
import { EntryContent } from "@/components/entries/EntryContent";
import { AppearanceProvider } from "@/lib/appearance/AppearanceProvider";
import { KeyboardShortcutsProvider } from "@/components/keyboard/KeyboardShortcutsProvider";
import {
  renderWithTrpc,
  stubMemoryLocalStorage,
  type ProcedureHandlers,
} from "../../../utils/component-test-helpers";

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

// EntryContentBody reads text styles from AppearanceProvider and narration
// controls from KeyboardShortcutsProvider; wrap every render in both.
function renderEntryContent(ui: React.ReactElement, handlers: ProcedureHandlers) {
  return renderWithTrpc(ui, {
    handlers,
    wrapper: (children) => (
      <AppearanceProvider>
        <KeyboardShortcutsProvider>{children}</KeyboardShortcutsProvider>
      </AppearanceProvider>
    ),
  });
}

/** A full entry as returned by `entries.get` (only the fields EntryContent reads). */
function createEntry(overrides: Record<string, unknown> = {}) {
  return {
    id: "entry-1",
    feedId: "feed-1",
    subscriptionId: "sub-1",
    type: "web",
    url: "https://example.com/article",
    title: "The Great Article",
    author: "Jane Doe",
    summary: "A short summary.",
    publishedAt: new Date("2024-06-15T10:00:00Z"),
    fetchedAt: new Date("2024-06-15T11:00:00Z"),
    contentOriginal: "<p>Original body content here.</p>",
    contentCleaned: "<p>Cleaned body content here.</p>",
    read: false,
    starred: false,
    feedTitle: "Example Feed",
    feedUrl: "https://example.com/feed.xml",
    siteName: null,
    unsubscribeUrl: null,
    fetchFullContent: false,
    fullContentOriginal: null,
    fullContentCleaned: null,
    fullContentFetchedAt: null,
    fullContentError: null,
    ...overrides,
  };
}

/** Handlers for the queries/mutations EntryContent issues on mount. */
function baseHandlers(overrides: ProcedureHandlers = {}): ProcedureHandlers {
  return {
    "entries.get": (input) => ({ entry: createEntry({ id: (input as { id: string }).id }) }),
    "summarization.isAvailable": () => ({ available: false }),
    "entries.markRead": (input) => {
      const entries = (input as { entries: { id: string }[] }).entries;
      return {
        entries: entries.map((e) => ({
          id: e.id,
          read: true,
          starred: false,
          updatedAt: new Date("2024-06-15T12:00:00Z"),
        })),
        counts: {
          all: { unread: 0 },
          starred: { unread: 0 },
          saved: { unread: 0 },
          subscriptions: [],
          tags: [],
        },
      };
    },
    ...overrides,
  };
}

describe("EntryContent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stubMemoryLocalStorage();
  });

  it("renders the entry title and content from entries.get", async () => {
    renderEntryContent(<EntryContent entryId="entry-1" />, baseHandlers());

    expect(await screen.findByRole("link", { name: "The Great Article" })).toBeInTheDocument();
    // The cleaned content is rendered (default when no show-original preference).
    expect(await screen.findByText("Cleaned body content here.")).toBeInTheDocument();
    // Source (feed title) is shown in the meta row.
    expect(screen.getByText("Example Feed")).toBeInTheDocument();
  });

  it("requests the entry by the given id", async () => {
    const { callsFor } = renderEntryContent(<EntryContent entryId="entry-42" />, baseHandlers());

    await screen.findByRole("link", { name: "The Great Article" });

    const getCalls = callsFor("entries.get");
    expect(getCalls.some((c) => (c.input as { id: string }).id === "entry-42")).toBe(true);
  });

  it("auto-marks the entry as read on mount", async () => {
    const { callsFor } = renderEntryContent(<EntryContent entryId="entry-1" />, baseHandlers());

    await screen.findByRole("link", { name: "The Great Article" });

    await vi.waitFor(() => {
      const markReadCalls = callsFor("entries.markRead");
      expect(markReadCalls).toHaveLength(1);
      expect(markReadCalls[0].input).toMatchObject({
        entries: [{ id: "entry-1" }],
        read: true,
      });
    });
  });

  it("prefetches the next entry when nextEntryId is provided", async () => {
    const { callsFor } = renderEntryContent(
      <EntryContent entryId="entry-1" nextEntryId="entry-next" />,
      baseHandlers()
    );

    await screen.findByRole("link", { name: "The Great Article" });

    await vi.waitFor(() => {
      const getCalls = callsFor("entries.get");
      expect(getCalls.some((c) => (c.input as { id: string }).id === "entry-next")).toBe(true);
    });
  });

  it("shows the error fallback when entries.get fails", async () => {
    renderEntryContent(
      <EntryContent entryId="entry-1" />,
      baseHandlers({
        "entries.get": () => {
          throw new Error("Entry not found");
        },
      })
    );

    expect(await screen.findByText("Failed to load entry")).toBeInTheDocument();
  });
});
