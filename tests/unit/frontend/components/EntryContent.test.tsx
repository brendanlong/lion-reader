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

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { getLocalDb } from "@/lib/local-db/local-db";
import { patchServerEntryMetadata } from "@/lib/local-db/entries";
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
    updatedAt: new Date("2024-06-15T11:00:00Z"),
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

  it("still sends the mark-read for an entry that is already read (moves it up Recently Read)", async () => {
    const { callsFor } = renderEntryContent(
      <EntryContent entryId="entry-1" />,
      baseHandlers({
        "entries.get": (input) => ({
          entry: createEntry({ id: (input as { id: string }).id, read: true }),
        }),
      })
    );

    await screen.findByRole("link", { name: "The Great Article" });
    await vi.waitFor(() => expect(callsFor("entries.markRead")).toHaveLength(1));
  });

  it("renders metadata from the local entry store, so a live rename shows in the open entry", async () => {
    const { queryClient } = renderEntryContent(<EntryContent entryId="entry-1" />, baseHandlers());
    await screen.findByRole("link", { name: "The Great Article" });

    act(() => {
      patchServerEntryMetadata(
        getLocalDb(queryClient).entries,
        "entry-1",
        {
          title: "Renamed Article",
          author: "Jane Doe",
          summary: null,
          url: "https://example.com/article",
          publishedAt: new Date("2024-06-15T10:00:00Z"),
        },
        new Date("2024-06-15T12:00:00Z")
      );
    });

    expect(await screen.findByRole("link", { name: "Renamed Article" })).toBeInTheDocument();
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

describe("EntryContent summaries", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stubMemoryLocalStorage();
  });

  /** An entry whose full content is fetched, so the toggle switches versions at once. */
  function summaryHandlers() {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const handlers = baseHandlers({
      "entries.get": () => ({
        entry: createEntry({
          fullContentCleaned: "<p>Full body content here.</p>",
          fullContentFetchedAt: new Date("2024-06-15T11:30:00Z"),
        }),
      }),
      "summarization.isAvailable": () => ({ available: true }),
      "summarization.generate": async (input) => {
        await gate;
        const full = (input as { useFullContent?: boolean }).useFullContent;
        return {
          summary: `<p>${full ? "Full" : "Feed"} summary.</p>`,
          modelId: "test-model",
          generatedAt: null,
          settingsChanged: false,
        };
      },
      "subscriptions.update": () => ({}),
    });
    return { handlers, release };
  }

  it("files a summary under the version it was requested for, not the one now shown", async () => {
    const { handlers, release } = summaryHandlers();
    const { callsFor } = renderEntryContent(<EntryContent entryId="entry-1" />, handlers);

    fireEvent.click(await screen.findByRole("button", { name: "Generate AI summary" }));
    await waitFor(() => expect(callsFor("summarization.generate")).toHaveLength(1));
    expect(callsFor("summarization.generate")[0].input).toMatchObject({ useFullContent: false });

    fireEvent.click(screen.getByRole("button", { name: "Fetch and display full article content" }));
    expect(await screen.findByText("Full body content here.")).toBeInTheDocument();

    await act(async () => {
      release();
    });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Generate AI summary" })).toBeEnabled()
    );
    expect(screen.queryByText("Feed summary.")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Switch to feed content" }));
    expect(await screen.findByText("Feed summary.")).toBeInTheDocument();
  });
});

describe("EntryContent click-to-seek narration", () => {
  let speak: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    stubMemoryLocalStorage();
    speak = vi.fn();
    vi.stubGlobal("speechSynthesis", {
      speak,
      cancel: vi.fn(),
      pause: vi.fn(),
      resume: vi.fn(),
      getVoices: vi.fn(() => [{ voiceURI: "v", name: "V", lang: "en-US", default: true }]),
      onvoiceschanged: null,
    });
    vi.stubGlobal(
      "SpeechSynthesisUtterance",
      class {
        text: string;
        constructor(text: string) {
          this.text = text;
        }
      }
    );
    Element.prototype.scrollIntoView = vi.fn();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    window.getSelection()?.removeAllRanges();
  });

  const lastSpoken = () => (speak.mock.lastCall?.[0] as { text: string }).text;

  async function renderAndStartNarration() {
    const handlers = baseHandlers({
      "entries.get": () => ({
        entry: createEntry({
          contentCleaned: '<p>First</p><p>Second has <a href="#x">a link</a></p><p>Third</p>',
        }),
      }),
    });
    renderEntryContent(<EntryContent entryId="entry-1" />, handlers);
    fireEvent.click(await screen.findByRole("button", { name: "Listen" }));
    await waitFor(() => expect(lastSpoken()).toBe("First"));
    return within(document.querySelector(".reader-prose") as HTMLElement);
  }

  it("narrates from the clicked paragraph", async () => {
    const content = await renderAndStartNarration();

    fireEvent.click(content.getByText("Third"));

    await waitFor(() => expect(lastSpoken()).toBe("Third"));
  });

  it("does not seek when following a link", async () => {
    const content = await renderAndStartNarration();
    const calls = speak.mock.calls.length;

    fireEvent.click(content.getByText("a link"));

    expect(speak.mock.calls.length).toBe(calls);
  });

  it("does not seek on a multi-click or when dismissing a selection", async () => {
    const content = await renderAndStartNarration();
    const calls = speak.mock.calls.length;
    const third = content.getByText("Third");

    fireEvent.click(third, { detail: 2 });

    window.getSelection()?.selectAllChildren(content.getByText("First"));
    fireEvent.pointerDown(third);
    // The browser collapses the selection between pointerdown and click.
    window.getSelection()?.removeAllRanges();
    fireEvent.click(third);

    expect(speak.mock.calls.length).toBe(calls);
  });
});
