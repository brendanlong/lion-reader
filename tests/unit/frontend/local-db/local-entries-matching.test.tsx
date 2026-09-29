/**
 * @vitest-environment jsdom
 */

/**
 * Tests for useLocalEntriesMatching, the entry-list loading fallback: while a
 * view's first page loads, it shows the stored entries that match the view's
 * filters, from whichever lists (or reader opens) put them in the store.
 */

import { describe, it, expect, afterEach } from "vitest";
import { act, cleanup, waitFor } from "@testing-library/react";
import { useLocalEntriesMatching } from "@/lib/hooks/useLocalEntries";
import { getLocalDb } from "@/lib/local-db/local-db";
import { upsertServerEntries, type EntryRow } from "@/lib/local-db/entries";
import type { EntryListFilters } from "@/lib/local-db/entry-lists";
import { renderHookWithTrpc } from "../../../utils/component-test-helpers";

afterEach(() => {
  cleanup();
});

function makeEntry(id: string, publishedAt: string, overrides: Partial<EntryRow> = {}): EntryRow {
  return {
    id,
    feedId: "feed-1",
    subscriptionId: "sub-1",
    type: "web",
    url: null,
    title: id,
    author: null,
    summary: null,
    publishedAt: new Date(publishedAt),
    fetchedAt: new Date(publishedAt),
    updatedAt: new Date("2024-07-01T00:00:00Z"),
    read: false,
    starred: false,
    feedTitle: null,
    siteName: null,
    ...overrides,
  };
}

const STORED = [
  makeEntry("a", "2024-06-01"),
  makeEntry("b", "2024-06-02", { subscriptionId: "sub-2" }),
  makeEntry("c", "2024-06-03", { read: true }),
  makeEntry("d", "2024-06-04", { starred: true }),
  makeEntry("e", "2024-06-05", { type: "saved", subscriptionId: null }),
];

function renderMatching(filters: EntryListFilters, subscriptionIds?: string[] | null) {
  const rendered = renderHookWithTrpc(() => useLocalEntriesMatching(filters, subscriptionIds));
  act(() => upsertServerEntries(getLocalDb(rendered.queryClient).entries, STORED));
  return () => rendered.result.current?.map((entry) => entry.id);
}

describe("useLocalEntriesMatching", () => {
  it("returns every stored entry newest first for the All view", async () => {
    const ids = renderMatching({});
    await waitFor(() => expect(ids()).toEqual(["e", "d", "c", "b", "a"]));
  });

  it("returns oldest first for an oldest-sorted view", async () => {
    const ids = renderMatching({ sortOrder: "oldest" });
    await waitFor(() => expect(ids()).toEqual(["a", "b", "c", "d", "e"]));
  });

  it("narrows to a subscription, dropping read entries in an unread-only view", async () => {
    const ids = renderMatching({ subscriptionId: "sub-1", unreadOnly: true });
    await waitFor(() => expect(ids()).toEqual(["d", "a"]));
  });

  it("narrows tag views to the given subscriptions", async () => {
    const ids = renderMatching({ tagId: "tag-1" }, ["sub-2"]);
    await waitFor(() => expect(ids()).toEqual(["b"]));
  });

  it("is disabled when a tag view's subscriptions aren't known", async () => {
    const ids = renderMatching({ tagId: "tag-1" }, null);
    await act(async () => {});
    expect(ids()).toBeUndefined();
  });

  it("honors starred and type filters", async () => {
    const starred = renderMatching({ starredOnly: true });
    const saved = renderMatching({ type: "saved" });
    await waitFor(() => expect(starred()).toEqual(["d"]));
    expect(saved()).toEqual(["e"]);
  });
});
