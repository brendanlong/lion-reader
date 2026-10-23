import { describe, it, expect } from "vitest";
import {
  entryListPayload,
  entryRowToSyncEvents,
  newEntryAnnouncement,
  toEntryMetadata,
  type ChangedEntryRow,
} from "@/server/services/entry-sync-events";

const counts = {
  all: { unread: 3 },
  starred: { unread: 0 },
  saved: { unread: 0 },
  subscriptions: [{ id: "sub-1", unread: 3, tagIds: [] }],
  tags: [],
  asOf: "2026-10-01T12:00:00.123456Z",
};

const updatedAt = "2026-10-01T12:00:00.123456Z";
// Older than `updatedAt`, which a later state change moved past it.
const entryUpdatedAt = "2026-10-01T11:45:00.000Z";

function row(overrides: Partial<ChangedEntryRow> = {}): ChangedEntryRow {
  return {
    id: "entry-1",
    title: "A post",
    author: "Someone",
    summary: "What it says",
    url: "https://example.com/post",
    publishedAt: new Date("2026-10-01T11:00:00Z"),
    fetchedAt: new Date("2026-10-01T11:30:00Z"),
    siteName: "Example",
    entryUpdatedAt: new Date(entryUpdatedAt),
    isSpam: false,
    read: false,
    starred: false,
    readChangedAt: null,
    subscriptionId: "sub-1",
    subscriptionIds: ["sub-1"],
    tagLists: { tagIds: [], uncategorized: false },
    positions: {},
    score: null,
    type: "web",
    feedTitle: "Example feed",
    metadataChanged: true,
    stateChanged: true,
    isNew: true,
    updatedAt,
    ...overrides,
  };
}

const allCounts = { newEntry: counts, stateChanged: counts };
const typesOf = (r: ChangedEntryRow) => entryRowToSyncEvents(r, allCounts).map((e) => e.type);

describe("entryRowToSyncEvents", () => {
  it("announces a new entry with its list payload, current state and counts", () => {
    const tagLists = { tagIds: ["tag-1"], uncategorized: true };
    const [event] = entryRowToSyncEvents(row({ starred: true, tagLists }), allCounts);
    expect(event).toEqual({
      type: "new_entry",
      subscriptionId: "sub-1",
      subscriptionIds: ["sub-1"],
      tagLists,
      entryId: "entry-1",
      timestamp: updatedAt,
      updatedAt,
      entry: {
        type: "web",
        title: "A post",
        author: "Someone",
        summary: "What it says",
        url: "https://example.com/post",
        publishedAt: "2026-10-01T11:00:00.000Z",
        fetchedAt: "2026-10-01T11:30:00.000Z",
        siteName: "Example",
        feedTitle: "Example feed",
        entryUpdatedAt,
        read: false,
        starred: true,
        readChangedAt: null,
      },
      counts,
    });
  });

  it.each<[string, Partial<ChangedEntryRow>, string[]]>([
    ["a new entry", {}, ["new_entry", "entry_state_changed"]],
    ["a new entry linked read (a backfill)", { read: true }, ["entry_state_changed"]],
    [
      "a new entry the user has read since",
      { read: true, readChangedAt: new Date("2026-10-01T12:00:00.000Z") },
      ["new_entry", "entry_state_changed"],
    ],
    ["an edited entry", { isNew: false, stateChanged: false }, ["entry_updated"]],
    ["an entry read since", { isNew: false, metadataChanged: false }, ["entry_state_changed"]],
    ["an entry edited and read since", { isNew: false }, ["entry_updated", "entry_state_changed"]],
  ])("reports %s", (_, overrides, expected) => {
    expect(typesOf(row(overrides))).toEqual(expected);
  });

  it("gives spam no list payload, but still announces it for the counts", () => {
    const events = entryRowToSyncEvents(row({ isSpam: true }), allCounts);
    expect(events.map((e) => e.type)).toEqual(["new_entry", "entry_state_changed"]);
    for (const event of events) expect(event).not.toHaveProperty("entry");
  });

  it("carries a list payload on a state change only while the entry is unread", () => {
    const unread = entryRowToSyncEvents(row({ isNew: false, metadataChanged: false }), allCounts);
    expect(unread[0]).toMatchObject({
      type: "entry_state_changed",
      subscriptionId: "sub-1",
      subscriptionIds: ["sub-1"],
      entry: { title: "A post", type: "web" },
    });
    const tagLists = { tagIds: ["tag-1"], uncategorized: false };
    const read = entryRowToSyncEvents(
      row({ isNew: false, metadataChanged: false, read: true, tagLists }),
      allCounts
    );
    expect(read[0]).not.toHaveProperty("entry");
    expect(read[0]).not.toHaveProperty("subscriptionId");
    // Memberships and tag lists travel with every state change.
    expect(read[0]).toMatchObject({ subscriptionIds: ["sub-1"], tagLists });
  });

  it("reports the entry's edit as entry_updated metadata", () => {
    const [event] = entryRowToSyncEvents(row({ isNew: false, stateChanged: false }), allCounts);
    expect(event).toEqual({
      type: "entry_updated",
      subscriptionId: "sub-1",
      entryId: "entry-1",
      timestamp: updatedAt,
      updatedAt,
      entryUpdatedAt,
      metadata: toEntryMetadata(row()),
    });
  });

  it("sends the list payload the live path sends, plus the entry's state", () => {
    const changed = row();
    const live = newEntryAnnouncement({ ...changed, isBackfill: false }, changed.feedTitle);
    const [catchUp] = entryRowToSyncEvents(changed, allCounts);
    expect(catchUp.type).toBe("new_entry");
    const entry = catchUp.type === "new_entry" ? catchUp.entry : undefined;
    expect(entry).toEqual({
      ...live?.entry,
      read: false,
      starred: false,
      readChangedAt: null,
    });
  });
});

describe("newEntryAnnouncement", () => {
  const entry = { ...row(), isSpam: false, isBackfill: false };

  it("announces an entry with its list payload", () => {
    expect(newEntryAnnouncement(entry, "Feed")).toEqual({
      entry: entryListPayload(entry, "Feed"),
    });
  });

  it("announces spam without one", () => {
    expect(newEntryAnnouncement({ ...entry, isSpam: true }, "Feed")).toEqual({});
  });

  it("doesn't announce a backfill", () => {
    expect(newEntryAnnouncement({ ...entry, isBackfill: true }, "Feed")).toBeNull();
  });
});
