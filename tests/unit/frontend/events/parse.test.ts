/**
 * Unit tests for SSE event parsing.
 */

import { describe, it, expect } from "vitest";
import { parseSyncEvent } from "@/lib/events/parse";
import { SYNC_PROTOCOL_VERSION } from "@/lib/events/schemas";

describe("parseSyncEvent", () => {
  it("parses a valid event and strips server-only fields", () => {
    const event = parseSyncEvent(
      JSON.stringify({
        v: SYNC_PROTOCOL_VERSION,
        type: "tag_deleted",
        tagId: "tag-1",
        timestamp: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        userId: "user-1",
      })
    );
    expect(event).toEqual({
      type: "tag_deleted",
      tagId: "tag-1",
      timestamp: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
  });

  it("parses a mark_all_read event and strips server-only userId", () => {
    const event = parseSyncEvent(
      JSON.stringify({
        v: SYNC_PROTOCOL_VERSION,
        type: "mark_all_read",
        userId: "user-1",
        timestamp: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        entryId: "entry-1",
      })
    );
    expect(event).toEqual({
      type: "mark_all_read",
      timestamp: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      entryId: "entry-1",
    });
  });

  it("returns 'outdated' for an event without a protocol version (previous release)", () => {
    expect(
      parseSyncEvent(
        JSON.stringify({
          type: "mark_all_read",
          userId: "user-1",
          timestamp: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        })
      )
    ).toBe("outdated");
  });

  it("returns 'outdated' for an event from a different protocol version", () => {
    expect(
      parseSyncEvent(
        JSON.stringify({
          v: SYNC_PROTOCOL_VERSION + 1,
          type: "tag_deleted",
          tagId: "tag-1",
          timestamp: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        })
      )
    ).toBe("outdated");
  });

  it("returns null for unknown event types at the current version", () => {
    expect(
      parseSyncEvent(JSON.stringify({ v: SYNC_PROTOCOL_VERSION, type: "connected", cursor: "abc" }))
    ).toBeNull();
  });

  it("returns null for invalid JSON", () => {
    expect(parseSyncEvent("not json")).toBeNull();
  });

  it("returns null for non-object JSON", () => {
    expect(parseSyncEvent(JSON.stringify("heartbeat"))).toBeNull();
  });
});
