/**
 * Unit tests for sync cursor bookkeeping.
 */

import { describe, it, expect } from "vitest";
import { advanceCursors, cursorTypeForEvent, type SyncCursors } from "@/lib/events/cursors";
import type { SyncEvent } from "@/lib/events/schemas";

const EMPTY_CURSORS: SyncCursors = {
  entries: null,
  entriesAfterId: null,
  subscriptions: null,
  tags: null,
};

function entryEvent(updatedAt: string, entryId = "entry-1"): SyncEvent {
  return {
    type: "entry_state_changed",
    entryId,
    read: true,
    starred: false,
    counts: { all: { unread: 0 }, starred: { unread: 0 }, subscriptions: [], tags: [] },
    timestamp: updatedAt,
    updatedAt,
  };
}

function subscriptionEvent(updatedAt: string): SyncEvent {
  return {
    type: "subscription_deleted",
    subscriptionId: "sub-1",
    timestamp: updatedAt,
    updatedAt,
  };
}

function tagEvent(updatedAt: string): SyncEvent {
  return {
    type: "tag_deleted",
    tagId: "tag-1",
    timestamp: updatedAt,
    updatedAt,
  };
}

function markAllReadEvent(updatedAt: string, entryId?: string): SyncEvent {
  return {
    type: "mark_all_read",
    timestamp: updatedAt,
    updatedAt,
    ...(entryId !== undefined ? { entryId } : {}),
  };
}

function importEvent(): SyncEvent {
  return {
    type: "import_completed",
    importId: "import-1",
    imported: 1,
    skipped: 0,
    failed: 0,
    total: 1,
    timestamp: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("cursorTypeForEvent", () => {
  it("maps entry events to the entries cursor", () => {
    expect(cursorTypeForEvent(entryEvent("2026-01-01T00:00:00.000Z"))).toBe("entries");
  });

  it("maps subscription events to the subscriptions cursor", () => {
    expect(cursorTypeForEvent(subscriptionEvent("2026-01-01T00:00:00.000Z"))).toBe("subscriptions");
  });

  it("maps tag events to the tags cursor", () => {
    expect(cursorTypeForEvent(tagEvent("2026-01-01T00:00:00.000Z"))).toBe("tags");
  });

  it("maps mark_all_read to the entries cursor (avoids catch-up re-delivery)", () => {
    expect(cursorTypeForEvent(markAllReadEvent("2026-01-01T00:00:00.000Z"))).toBe("entries");
  });

  it("returns null for import events", () => {
    expect(cursorTypeForEvent(importEvent())).toBeNull();
  });
});

describe("advanceCursors", () => {
  it("initializes a null cursor from the event", () => {
    const next = advanceCursors(EMPTY_CURSORS, entryEvent("2026-01-01T00:00:00.000Z"));
    expect(next).toEqual({
      entries: "2026-01-01T00:00:00.000Z",
      entriesAfterId: "entry-1",
      subscriptions: null,
      tags: null,
    });
  });

  it("only advances the cursor for the event's entity type", () => {
    const cursors: SyncCursors = {
      entries: "2026-01-01T00:00:00.000Z",
      entriesAfterId: "entry-0",
      subscriptions: "2026-01-01T00:00:00.000Z",
      tags: "2026-01-01T00:00:00.000Z",
    };
    const next = advanceCursors(cursors, tagEvent("2026-01-02T00:00:00.000Z"));
    expect(next).toEqual({ ...cursors, tags: "2026-01-02T00:00:00.000Z" });
  });

  it("moves a cursor forward for newer events", () => {
    const cursors = advanceCursors(EMPTY_CURSORS, subscriptionEvent("2026-01-01T00:00:00.000Z"));
    const next = advanceCursors(cursors, subscriptionEvent("2026-01-03T12:00:00.000Z"));
    expect(next.subscriptions).toBe("2026-01-03T12:00:00.000Z");
  });

  it("advances the entries cursor from a mark_all_read event", () => {
    const next = advanceCursors(EMPTY_CURSORS, markAllReadEvent("2026-02-01T00:00:00.000Z"));
    expect(next.entries).toBe("2026-02-01T00:00:00.000Z");
  });

  it("does not move a cursor backwards for older or equal events", () => {
    const cursors = advanceCursors(EMPTY_CURSORS, entryEvent("2026-01-02T00:00:00.000Z"));
    expect(advanceCursors(cursors, entryEvent("2026-01-01T00:00:00.000Z"))).toBe(cursors);
    expect(advanceCursors(cursors, entryEvent("2026-01-02T00:00:00.000Z"))).toBe(cursors);
  });

  it("returns the same object for events that don't affect cursors", () => {
    expect(advanceCursors(EMPTY_CURSORS, importEvent())).toBe(EMPTY_CURSORS);
  });

  // #683: cursors carry microsecond precision. A new Date() comparison truncates
  // to milliseconds, so an event newer by microseconds within the same
  // millisecond would fail to advance the cursor. Temporal.Instant.compare fixes
  // this — the sub-millisecond-newer event must move the cursor forward.
  it("advances the cursor for an event newer by microseconds within the same millisecond", () => {
    const cursors = advanceCursors(EMPTY_CURSORS, subscriptionEvent("2026-01-01T00:00:00.000500Z"));
    const next = advanceCursors(cursors, subscriptionEvent("2026-01-01T00:00:00.000800Z"));
    expect(next.subscriptions).toBe("2026-01-01T00:00:00.000800Z");
  });

  it("does not advance the cursor for an event older by microseconds within the same millisecond", () => {
    const cursors = advanceCursors(EMPTY_CURSORS, subscriptionEvent("2026-01-01T00:00:00.000800Z"));
    expect(advanceCursors(cursors, subscriptionEvent("2026-01-01T00:00:00.000500Z"))).toBe(cursors);
  });

  it("advances the entries keyset for an entry event newer by microseconds", () => {
    const cursors = advanceCursors(EMPTY_CURSORS, entryEvent("2026-01-01T00:00:00.000100Z", "a"));
    const next = advanceCursors(cursors, entryEvent("2026-01-01T00:00:00.000200Z", "a"));
    expect(next.entries).toBe("2026-01-01T00:00:00.000200Z");
  });

  // A legacy to_char cursor always had 6 fractional digits; Temporal trims
  // trailing zeros. Comparing as instants (not strings) keeps a same-moment event
  // in the tied-timestamp group so its id tiebreaker still advances (#683).
  it("treats a trailing-zero-trimmed event as equal to a legacy 6-digit cursor", () => {
    const legacy: SyncCursors = {
      entries: "2026-01-01T00:00:00.123000Z",
      entriesAfterId: "a",
      subscriptions: null,
      tags: null,
    };
    const next = advanceCursors(legacy, entryEvent("2026-01-01T00:00:00.123Z", "b"));
    expect(next.entriesAfterId).toBe("b");
    expect(next.entries).toBe("2026-01-01T00:00:00.123000Z");
  });

  describe("entries keyset (ts, entriesAfterId)", () => {
    const T = "2026-01-01T00:00:00.000000Z";

    it("resets the id tiebreaker when the timestamp advances", () => {
      const cursors = advanceCursors(EMPTY_CURSORS, entryEvent(T, "b"));
      const later = advanceCursors(cursors, entryEvent("2026-01-02T00:00:00.000000Z", "a"));
      expect(later.entries).toBe("2026-01-02T00:00:00.000000Z");
      expect(later.entriesAfterId).toBe("a");
    });

    it("advances the id tiebreaker forward within a tied-timestamp group", () => {
      // Same timestamp, larger id → tiebreaker moves forward, timestamp stays.
      const cursors = advanceCursors(EMPTY_CURSORS, entryEvent(T, "a"));
      const next = advanceCursors(cursors, entryEvent(T, "c"));
      expect(next.entries).toBe(T);
      expect(next.entriesAfterId).toBe("c");
    });

    it("does not move the id tiebreaker backward within a tied-timestamp group", () => {
      const cursors = advanceCursors(EMPTY_CURSORS, entryEvent(T, "c"));
      // Same timestamp, smaller id → no change (already processed).
      expect(advanceCursors(cursors, entryEvent(T, "a"))).toBe(cursors);
    });

    // #1102: mark_all_read carries the LARGEST marked entry id, so the cursor
    // lands exactly past the marked rows instead of past the whole tied group.
    // A same-millisecond unrelated entry (UUIDv7 id above every earlier-created
    // marked entry) stays after the cursor and is still delivered by catch-up.
    it("advances to the max marked id for mark_all_read, keeping later tied ids syncable", () => {
      const cursors = advanceCursors(EMPTY_CURSORS, entryEvent(T, "b"));
      const next = advanceCursors(cursors, markAllReadEvent(T, "d"));
      expect(next.entries).toBe(T);
      expect(next.entriesAfterId).toBe("d");
    });

    it("does not move the tiebreaker backward for a mark_all_read with a smaller max id", () => {
      const cursors = advanceCursors(EMPTY_CURSORS, entryEvent(T, "e"));
      expect(advanceCursors(cursors, markAllReadEvent(T, "c"))).toBe(cursors);
    });

    it("falls back to skipping the whole tied group when mark_all_read has no entryId", () => {
      // Events from servers predating the entryId field (#1102).
      const cursors = advanceCursors(EMPTY_CURSORS, entryEvent(T, "b"));
      const next = advanceCursors(cursors, markAllReadEvent(T));
      expect(next.entries).toBe(T);
      // ffff… is larger than any real uuid, so the next sync skips every tied row.
      expect(next.entriesAfterId).toBe("ffffffff-ffff-ffff-ffff-ffffffffffff");
    });
  });
});
