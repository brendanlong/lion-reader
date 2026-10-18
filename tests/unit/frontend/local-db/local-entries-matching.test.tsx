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
import type { QueryClient } from "@tanstack/react-query";
import { useLocalEntriesMatching } from "@/lib/hooks/useLocalEntries";
import { getLocalDb } from "@/lib/local-db/local-db";
import { upsertServerEntries, type EntryRow } from "@/lib/local-db/entries";
import { writeLiveSubscriptions } from "@/lib/local-db/subscriptions";
import type { EntryListFilters } from "@/lib/local-db/entry-lists";
import { SAVED_SUBSCRIPTION_LIST_INPUT } from "@/lib/queries/saved-subscription";
import { renderHookWithTrpc } from "../../../utils/component-test-helpers";
import { createSubscriptionRow, savedSubscriptionRow } from "../../../utils/cache-test-helpers";

afterEach(() => {
  cleanup();
});

function makeEntry(id: string, publishedAt: string, overrides: Partial<EntryRow> = {}): EntryRow {
  return {
    id,
    subscriptionId: "sub-1",
    subscriptionIds: ["sub-1"],
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
  makeEntry("b", "2024-06-02", { subscriptionId: "sub-2", subscriptionIds: ["sub-2"] }),
  makeEntry("c", "2024-06-03", { read: true }),
  makeEntry("d", "2024-06-04", { starred: true }),
  makeEntry("e", "2024-06-05", {
    type: "saved",
    subscriptionId: "sub-saved",
    subscriptionIds: ["sub-saved"],
  }),
  // A feed article in collection col-1 and in Saved.
  makeEntry("f", "2024-06-06", { read: true, subscriptionIds: ["sub-1", "col-1", "sub-saved"] }),
];

/** Lands the `subscriptions.list` result that lists the saved subscription. */
function learnSavedSubscription(queryClient: QueryClient): void {
  act(() => {
    queryClient.setQueryData(
      [["subscriptions", "list"], { input: SAVED_SUBSCRIPTION_LIST_INPUT, type: "query" }],
      { items: [savedSubscriptionRow("sub-saved")] }
    );
  });
}

function renderMatching(
  filters: EntryListFilters,
  {
    savedKnown = true,
    subscriptions = {},
  }: { savedKnown?: boolean; subscriptions?: Record<string, string[]> } = {}
) {
  const rendered = renderHookWithTrpc(() => useLocalEntriesMatching(filters));
  const db = getLocalDb(rendered.queryClient);
  act(() => {
    upsertServerEntries(db.entries, STORED);
    writeLiveSubscriptions(
      db.subscriptions,
      Object.entries(subscriptions).map(([id, tagIds]) =>
        createSubscriptionRow({
          id,
          tags: tagIds.map((tagId) => ({ id: tagId, name: tagId, color: null })),
        })
      )
    );
  });
  if (savedKnown) learnSavedSubscription(rendered.queryClient);
  const ids = () => rendered.result.current?.map((entry) => entry.id);
  return Object.assign(ids, { learnSaved: () => learnSavedSubscription(rendered.queryClient) });
}

describe("useLocalEntriesMatching", () => {
  it("returns every stored entry newest first for the All view", async () => {
    const ids = renderMatching({});
    await waitFor(() => expect(ids()).toEqual(["f", "e", "d", "c", "b", "a"]));
  });

  it("returns oldest first for an oldest-sorted view", async () => {
    const ids = renderMatching({ sortOrder: "oldest" });
    await waitFor(() => expect(ids()).toEqual(["a", "b", "c", "d", "e", "f"]));
  });

  it("narrows to a subscription, dropping read entries in an unread-only view", async () => {
    const ids = renderMatching({ subscriptionId: "sub-1", unreadOnly: true });
    await waitFor(() => expect(ids()).toEqual(["d", "a"]));
  });

  it("narrows a collection's view to its members", async () => {
    const ids = renderMatching({ subscriptionId: "col-1" });
    await waitFor(() => expect(ids()).toEqual(["f"]));
  });

  it("narrows tag views to entries in a stored subscription with the tag", async () => {
    const ids = renderMatching(
      { tagId: "tag-1" },
      { subscriptions: { "sub-1": ["tag-2"], "sub-2": ["tag-1"], "col-1": ["tag-1"] } }
    );
    await waitFor(() => expect(ids()).toEqual(["f", "b"]));
  });

  it("narrows Uncategorized to entries in an untagged subscription other than Saved", async () => {
    const ids = renderMatching(
      { uncategorized: true },
      { subscriptions: { "sub-1": [], "sub-2": ["tag-1"], "sub-saved": [] } }
    );
    await waitFor(() => expect(ids()).toEqual(["f", "d", "c", "a"]));
  });

  it("shows nothing in a tag view while its subscriptions aren't stored", async () => {
    const ids = renderMatching({ tagId: "tag-1" });
    await act(async () => {});
    expect(ids()).toEqual([]);
  });

  it("honors the starred filter", async () => {
    const starred = renderMatching({ starredOnly: true });
    await waitFor(() => expect(starred()).toEqual(["d"]));
  });

  it("shows Saved by membership in the saved subscription, whatever the type", async () => {
    const saved = renderMatching({ type: "saved" });
    await waitFor(() => expect(saved()).toEqual(["f", "e"]));
  });

  it("shows nothing in Saved until the saved subscription is known, then its members", async () => {
    const saved = renderMatching({ type: "saved" }, { savedKnown: false });
    await act(async () => {});
    expect(saved()).toEqual([]);

    saved.learnSaved();
    await waitFor(() => expect(saved()).toEqual(["f", "e"]));
  });
});
