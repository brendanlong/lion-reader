/**
 * @vitest-environment jsdom
 */

/**
 * The subscribe flow's discovery step: entering a site URL that isn't itself a
 * feed lists the feeds found on the page, and picking one must show its preview
 * on the FIRST click (a disabled query's `refetch()` re-runs the key from the
 * previous render, so the click used to be a visible no-op until repeated).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { screen, fireEvent, waitFor } from "@testing-library/react";
import { renderWithTrpc, type ProcedureHandlers } from "../../../utils/component-test-helpers";

// sonner's toast is a side-effecting singleton (renders a portal); stub it so
// tests assert on component behavior, not the toast implementation.
vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(""),
  usePathname: () => "/subscribe",
}));

const { SubscribeContent } = await import("@/components/subscribe/SubscribeContent");

const SITE_URL = "https://example.com/";
const FEED_URL = "https://example.com/feed.xml";
const OTHER_FEED_URL = "https://example.com/comments.xml";

/** A feed preview shaped like the `feeds.preview` output. */
function preview(url: string, title: string) {
  return {
    feed: {
      url,
      title,
      description: "A feed about things",
      siteUrl: "https://example.com",
      iconUrl: null,
      sampleEntries: [
        {
          guid: "e1",
          link: "https://example.com/1",
          title: "First post",
          author: null,
          summary: "Summary of the first post",
          pubDate: new Date("2024-06-01T00:00:00Z"),
        },
      ],
    },
  };
}

/**
 * Handlers for the standard flow: the site URL is HTML (preview fails with the
 * message that triggers discovery), discovery finds two feeds, and previewing
 * either of them succeeds.
 */
function discoveryHandlers(overrides: ProcedureHandlers = {}): ProcedureHandlers {
  return {
    "feeds.preview": (input: never) => {
      const { url } = input as { url: string };
      if (url === FEED_URL) return preview(FEED_URL, "Example Blog");
      if (url === OTHER_FEED_URL) return preview(OTHER_FEED_URL, "Example Comments");
      throw new Error("No feeds found at this URL");
    },
    "feeds.discover": () => ({
      feeds: [
        { url: FEED_URL, type: "rss", title: "Example Blog" },
        { url: OTHER_FEED_URL, type: "atom", title: "Example Comments" },
      ],
      feedBuilderUrl: null,
    }),
    ...overrides,
  };
}

/** Runs the input step through to the discovery list. */
async function reachDiscoveryStep(): Promise<void> {
  fireEvent.change(screen.getByLabelText(/feed url/i), { target: { value: SITE_URL } });
  fireEvent.click(screen.getByRole("button", { name: /preview feed/i }));
  await screen.findByRole("heading", { name: /we found 2 feeds on this site/i });
}

beforeEach(() => {
  vi.stubGlobal("scrollTo", vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("SubscribeContent discovery step", () => {
  it("shows the feed preview on the first click of a discovered feed", async () => {
    const { callsFor } = renderWithTrpc(<SubscribeContent />, {
      handlers: discoveryHandlers(),
    });

    await reachDiscoveryStep();

    fireEvent.click(screen.getByRole("button", { name: /Example Blog/ }));

    expect(await screen.findByRole("heading", { name: "Example Blog" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^subscribe$/i })).toBeInTheDocument();
    expect(screen.getByText(FEED_URL)).toBeInTheDocument();

    // The preview after selection was fetched for the selected feed, not the
    // page URL we started from.
    const previewCalls = callsFor("feeds.preview").map(
      (call) => (call.input as { url: string }).url
    );
    expect(previewCalls).toEqual([SITE_URL, FEED_URL]);
  });

  it("previews the feed the user actually clicked when several were discovered", async () => {
    renderWithTrpc(<SubscribeContent />, { handlers: discoveryHandlers() });

    await reachDiscoveryStep();
    fireEvent.click(screen.getByRole("button", { name: /Example Comments/ }));

    expect(await screen.findByRole("heading", { name: "Example Comments" })).toBeInTheDocument();
  });

  it("surfaces an error and stays on the discovery list when the preview fails", async () => {
    renderWithTrpc(<SubscribeContent />, {
      handlers: discoveryHandlers({
        "feeds.preview": (input: never) => {
          const { url } = input as { url: string };
          if (url === FEED_URL) throw new Error("Feed server returned 500");
          throw new Error("No feeds found at this URL");
        },
      }),
    });

    await reachDiscoveryStep();
    fireEvent.click(screen.getByRole("button", { name: /Example Blog/ }));

    expect(await screen.findByText("Feed server returned 500")).toBeInTheDocument();
    // Still on discovery, so the user can pick the other feed.
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Example Comments/ })).toBeEnabled()
    );
  });
});
