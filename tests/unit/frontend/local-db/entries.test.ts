/**
 * Tests for the entry store's server writes. Freshness is tracked per group —
 * read/starred state and metadata — so a slow page fetch or an out-of-order
 * response can't overwrite newer data in either, and a write carrying one
 * group can't hold back the other (#1081).
 */

import { describe, it, expect, beforeEach } from "vitest";
import { createSyncedCollection } from "@/lib/local-db/synced-collection";
import {
  mergeServerEntry,
  patchServerEntryMetadata,
  setServerEntryState,
  upsertServerEntries,
  type EntryRow,
  type EntryStore,
  type EntryWrite,
  type StoredEntryRow,
} from "@/lib/local-db/entries";

const t1 = new Date("2026-07-05T00:00:01.000Z");
const t2 = new Date("2026-07-05T00:00:02.000Z");
const t3 = new Date("2026-07-05T00:00:03.000Z");

function makeEntry(overrides: Partial<EntryRow> = {}): EntryRow {
  return {
    id: "e1",
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

const metadata = (title: string) => ({
  title,
  author: null,
  summary: `${title} summary`,
  url: "https://example.com/e1",
  publishedAt: null,
});

const row = (overrides: Partial<EntryRow>): EntryWrite => ({
  kind: "row",
  row: makeEntry(overrides),
});
const state = (read: boolean, updatedAt: Date): EntryWrite => ({
  kind: "state",
  state: { read, starred: false },
  updatedAt,
});
const meta = (title: string, updatedAt: Date): EntryWrite => ({
  kind: "metadata",
  metadata: metadata(title),
  updatedAt,
});

/** Applies writes in order, as the store would, and returns the final row. */
function applyAll(writes: EntryWrite[]): StoredEntryRow | undefined {
  let stored: StoredEntryRow | undefined;
  for (const write of writes) stored = mergeServerEntry(stored, write) ?? stored;
  return stored;
}

describe("mergeServerEntry", () => {
  it.each<{ name: string; writes: EntryWrite[]; read: boolean; title: string }>([
    {
      name: "a newer row replaces both groups",
      writes: [row({ updatedAt: t1 }), row({ read: true, title: "New", updatedAt: t2 })],
      read: true,
      title: "New",
    },
    {
      name: "an older row changes nothing",
      writes: [row({ read: true, title: "New", updatedAt: t2 }), row({ updatedAt: t1 })],
      read: true,
      title: "New",
    },
    {
      name: "a same-time row applies (a refetch or re-delivery)",
      writes: [row({ title: "Old", updatedAt: t1 }), row({ title: "New", updatedAt: t1 })],
      read: false,
      title: "New",
    },
    {
      name: "a page fetched before a metadata change keeps the new metadata, takes its state",
      writes: [row({ updatedAt: t1 }), meta("Renamed", t3), row({ read: true, updatedAt: t2 })],
      read: true,
      title: "Renamed",
    },
    {
      name: "a page fetched before a state change keeps the new state, takes its metadata",
      writes: [row({ updatedAt: t1 }), state(true, t3), row({ title: "Edited", updatedAt: t2 })],
      read: true,
      title: "Edited",
    },
    {
      name: "a page fetched before both changes changes nothing",
      writes: [
        row({ updatedAt: t1 }),
        state(true, t3),
        meta("Renamed", t3),
        row({ updatedAt: t2 }),
      ],
      read: true,
      title: "Renamed",
    },
    {
      name: "a page fetched after both changes replaces both",
      writes: [
        row({ updatedAt: t1 }),
        state(true, t2),
        meta("Renamed", t2),
        row({ read: false, title: "Latest", updatedAt: t3 }),
      ],
      read: false,
      title: "Latest",
    },
    {
      name: "a state write older than the metadata still applies (mark-read racing a refresh)",
      writes: [row({ updatedAt: t1 }), meta("Renamed", t3), state(true, t2)],
      read: true,
      title: "Renamed",
    },
    {
      name: "a metadata write older than the state still applies",
      writes: [row({ updatedAt: t1 }), state(true, t3), meta("Renamed", t2)],
      read: true,
      title: "Renamed",
    },
    {
      name: "an older state write changes nothing",
      writes: [row({ read: true, updatedAt: t2 }), state(false, t1)],
      read: true,
      title: "Entry",
    },
    {
      name: "an older metadata write changes nothing",
      writes: [row({ title: "Edited", updatedAt: t2 }), meta("Stale", t1)],
      read: false,
      title: "Edited",
    },
    {
      name: "out-of-order state writes resolve to the newest",
      writes: [row({ updatedAt: t1 }), state(true, t3), state(false, t2)],
      read: true,
      title: "Entry",
    },
  ])("$name", ({ writes, read, title }) => {
    expect(applyAll(writes)).toMatchObject({ read, title });
  });

  it("returns undefined for a write that changes nothing", () => {
    const stored = mergeServerEntry(undefined, row({ updatedAt: t2 }));
    expect(mergeServerEntry(stored, row({ updatedAt: t1 }))).toBeUndefined();
    expect(mergeServerEntry(stored, state(true, t1))).toBeUndefined();
    expect(mergeServerEntry(stored, meta("Stale", t1))).toBeUndefined();
  });

  it("ignores partial writes for an entry it doesn't hold", () => {
    expect(mergeServerEntry(undefined, state(true, t2))).toBeUndefined();
    expect(mergeServerEntry(undefined, meta("Renamed", t2))).toBeUndefined();
  });

  it("moves only the written group's watermark", () => {
    const stored = applyAll([row({ updatedAt: t1 }), state(true, t2), meta("Renamed", t3)]);
    expect(stored).toMatchObject({ stateUpdatedAt: t2, metadataUpdatedAt: t3, updatedAt: t3 });
  });

  it("keeps the summary with the rest of the metadata", () => {
    const stored = applyAll([
      row({ updatedAt: t1 }),
      meta("Renamed", t3),
      row({ summary: "Old summary", updatedAt: t2 }),
    ]);
    expect(stored?.summary).toBe("Renamed summary");
  });
});

let store: EntryStore;

beforeEach(() => {
  store = createSyncedCollection<StoredEntryRow>({ id: "test-entries", getKey: (r) => r.id });
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

  it("merges repeated copies of an entry within one batch", () => {
    upsertServerEntries(store, [
      makeEntry({ title: "Newer", updatedAt: t2 }),
      makeEntry({ title: "Older", updatedAt: t1 }),
    ]);
    expect(store.collection.get("e1")?.title).toBe("Newer");
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
  it("isn't undone by a page fetched before the change landing after it", () => {
    upsertServerEntries(store, [makeEntry({ updatedAt: t1 })]);
    patchServerEntryMetadata(store, "e1", metadata("Renamed"), t3);
    upsertServerEntries(store, [makeEntry({ read: true, updatedAt: t2 })]);
    expect(store.collection.get("e1")).toMatchObject({
      title: "Renamed",
      summary: "Renamed summary",
      read: true,
    });
  });
});
