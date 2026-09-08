/**
 * Unit tests for parsing Notion `loadPageChunk` responses.
 */

import { describe, it, expect } from "vitest";
import { parseLoadPageChunkResponse } from "../../src/server/notion/api";

const PAGE_ID = "37bb1284-725b-81c6-9167-c4b2a67c26e1";

describe("parseLoadPageChunkResponse", () => {
  it("reads blocks in both record shapes and drops unreadable ones", () => {
    const json = JSON.stringify({
      cursor: { stack: [] },
      recordMap: {
        __version__: 3,
        block: {
          [PAGE_ID]: {
            spaceId: "space",
            value: {
              value: {
                id: PAGE_ID,
                version: 176,
                type: "page",
                properties: { title: [["How to succeed in SPAR"]] },
                content: ["child-1"],
                extra_field_we_do_not_know: { nested: true },
              },
              role: "reader",
            },
          },
          "child-1": {
            role: "reader",
            value: { id: "child-1", type: "text", properties: { title: [["Body"]] } },
          },
          "hidden-1": {},
          "hidden-2": { role: "none", value: {} },
          "hidden-3": { value: { value: { type: "text" }, role: "none" } },
        },
      },
    });

    const { blocks, nextCursor } = parseLoadPageChunkResponse(json);
    expect([...blocks.keys()]).toEqual([PAGE_ID, "child-1"]);
    expect(blocks.get(PAGE_ID)).toMatchObject({
      id: PAGE_ID,
      type: "page",
      content: ["child-1"],
      properties: { title: [["How to succeed in SPAR"]] },
    });
    expect(blocks.get("child-1")?.type).toBe("text");
    expect(nextCursor).toBeNull();
  });

  it("returns the cursor to continue with while the stack is non-empty", () => {
    const cursor = { stack: [[{ table: "block", id: "x", index: 30 }]] };
    const { nextCursor } = parseLoadPageChunkResponse(
      JSON.stringify({ cursor, recordMap: { block: {} } })
    );
    expect(nextCursor).toEqual(cursor);
  });

  it("treats a missing cursor or record map as the last, empty chunk", () => {
    const { blocks, nextCursor } = parseLoadPageChunkResponse("{}");
    expect(blocks.size).toBe(0);
    expect(nextCursor).toBeNull();
  });

  it("throws on a malformed envelope", () => {
    expect(() => parseLoadPageChunkResponse("not json")).toThrow();
    expect(() =>
      parseLoadPageChunkResponse(JSON.stringify({ recordMap: { block: [] } }))
    ).toThrow();
  });
});
