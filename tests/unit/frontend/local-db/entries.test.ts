/**
 * Tests for the entry store's server writes: every write is guarded by the
 * server's `updatedAt`, so a slow page fetch or an out-of-order response can't
 * overwrite newer state (#1081).
 */

import { describe, it, expect, beforeEach } from "vitest";
import { createSyncedCollection } from "@/lib/local-db/synced-collection";
import {
  patchServerEntryMetadata,
  setServerEntryState,
  upsertServerEntries,
  type EntryRow,
  type EntryStore,
} from "@/lib/local-db/entries";

const t1 = new Date("2026-07-05T00:00:01.000Z");
const t2 = new Date("2026-07-05T00:00:02.000Z");

function makeEntry(overrides: Partial<EntryRow> = {}): EntryRow {
  return {
    id: "e1",
    feedId: "feed-1",
    subscriptionId: "sub-1",
    type: "web",
    url: "https://example.com/e1",
    title: "Entry",
    author: null,
    summary: null,
    publishedAt: new Date("2026-07-01T00:00:00Z"),
    fetchedAt: new Date("2026-07-01T00:00:00Z"),
    updatedAt: t1,
    read: false,
    starred: false,
    feedTitle: "Feed",
    siteName: null,
    ...overrides,
  };
}

let store: EntryStore;

beforeEach(() => {
  store = createSyncedCollection<EntryRow>({ id: "test-entries", getKey: (row) => row.id });
});

describe("upsertServerEntries", () => {
  it("stores only the list-item fields of a fuller server entry", () => {
    upsertServerEntries(store, [{ ...makeEntry(), contentCleaned: "<p>big</p>" } as EntryRow]);
    expect(store.collection.get("e1")).not.toHaveProperty("contentCleaned");
  });

  it("skips a row older than the stored one (a slow page fetch)", () => {
    upsertServerEntries(store, [makeEntry({ read: true, updatedAt: t2 })]);
    upsertServerEntries(store, [makeEntry({ read: false, updatedAt: t1 })]);
    expect(store.collection.get("e1")?.read).toBe(true);
  });

  it("accepts a row with the same updatedAt (a re-delivered event)", () => {
    upsertServerEntries(store, [makeEntry({ title: "Old", updatedAt: t1 })]);
    upsertServerEntries(store, [makeEntry({ title: "New", updatedAt: t1 })]);
    expect(store.collection.get("e1")?.title).toBe("New");
  });
});

describe("setServerEntryState", () => {
  it("writes newer state", () => {
    upsertServerEntries(store, [makeEntry()]);
    setServerEntryState(store, "e1", { read: true, starred: true, updatedAt: t2 });
    expect(store.collection.get("e1")).toMatchObject({ read: true, starred: true, updatedAt: t2 });
  });

  it("ignores state older than what is stored", () => {
    upsertServerEntries(store, [makeEntry({ starred: true, updatedAt: t2 })]);
    setServerEntryState(store, "e1", { read: true, starred: false, updatedAt: t1 });
    expect(store.collection.get("e1")).toMatchObject({ read: false, starred: true });
  });

  it("ignores entries the store doesn't hold", () => {
    setServerEntryState(store, "missing", { read: true, starred: false, updatedAt: t2 });
    expect(store.collection.has("missing")).toBe(false);
  });
});

describe("patchServerEntryMetadata", () => {
  it("applies metadata without moving updatedAt, so a racing state write still lands", () => {
    upsertServerEntries(store, [makeEntry({ updatedAt: t1 })]);
    patchServerEntryMetadata(store, "e1", {
      title: "Renamed",
      author: "A",
      summary: "S",
      url: null,
      publishedAt: null,
    });
    expect(store.collection.get("e1")?.updatedAt).toEqual(t1);
    // A mark-read computed before the metadata change (its updatedAt predates
    // the entry_updated event's) must still apply.
    setServerEntryState(store, "e1", { read: true, starred: false, updatedAt: t2 });
    expect(store.collection.get("e1")).toMatchObject({ title: "Renamed", read: true });
  });
});
