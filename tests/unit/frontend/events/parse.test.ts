/**
 * Unit tests for SSE event parsing.
 */

import { describe, it, expect } from "vitest";
import { parseSyncEvent } from "@/lib/events/parse";

describe("parseSyncEvent", () => {
  it("parses a valid event and strips server-only fields", () => {
    const event = parseSyncEvent(
      JSON.stringify({
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

  it("returns null for unknown event types", () => {
    expect(parseSyncEvent(JSON.stringify({ type: "connected", cursor: "abc" }))).toBeNull();
  });

  it("returns null for invalid JSON", () => {
    expect(parseSyncEvent("not json")).toBeNull();
  });
});
