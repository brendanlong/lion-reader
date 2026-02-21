/**
 * Unit tests for Google Reader ID conversion functions.
 *
 * Tests the UUIDv7 ↔ int64 conversion, ID parsing, and formatting.
 */

import { describe, it, expect } from "vitest";
import {
  uuidToInt64,
  int64ToLongFormId,
  int64ToShortHex,
  parseItemId,
  subscriptionToStreamId,
  parseFeedStreamId,
} from "../../src/server/google-reader/id";
import {
  parseStreamId,
  stateStreamId,
  labelStreamId,
  isState,
} from "../../src/server/google-reader/streams";

describe("uuidToInt64", () => {
  it("produces a positive 63-bit integer", () => {
    const uuid = "0191a2b3-c4d5-7e6f-8a9b-0c1d2e3f4a5b";
    const result = uuidToInt64(uuid);
    expect(result).toBeGreaterThan(BigInt(0));
    // 63-bit max is 2^63 - 1
    expect(result).toBeLessThan(BigInt(2) ** BigInt(63));
  });

  it("is deterministic — same UUID produces same int64", () => {
    const uuid = "0191a2b3-c4d5-7e6f-8a9b-0c1d2e3f4a5b";
    const result1 = uuidToInt64(uuid);
    const result2 = uuidToInt64(uuid);
    expect(result1).toBe(result2);
  });

  it("different UUIDs produce different int64 values", () => {
    // These UUIDs differ in rand_a (byte 7) which is within the 15 extracted random bits
    const uuid1 = "0191a2b3-c4d5-7e6f-8a9b-0c1d2e3f4a5b";
    const uuid2 = "0191a2b3-c4d5-7e7f-8a9b-0c1d2e3f4a5b";
    const result1 = uuidToInt64(uuid1);
    const result2 = uuidToInt64(uuid2);
    expect(result1).not.toBe(result2);
  });

  it("UUIDs differing only in non-extracted bits may collide (known limitation)", () => {
    // UUIDs that differ only in the lower bits of rand_b (beyond the 15 extracted bits)
    // may produce the same int64 — this is an acceptable tradeoff for 63-bit IDs
    const uuid1 = "0191a2b3-c4d5-7e6f-8a9b-0c1d2e3f4a5b";
    const uuid2 = "0191a2b3-c4d5-7e6f-8a9b-0c1d2e3f4a5c";
    // These may or may not collide depending on which bits differ
    // This test documents the behavior, not asserts it
    const result1 = uuidToInt64(uuid1);
    const result2 = uuidToInt64(uuid2);
    expect(typeof result1).toBe("bigint");
    expect(typeof result2).toBe("bigint");
  });

  it("preserves time ordering — later UUID produces larger int64", () => {
    // UUID with earlier timestamp
    const uuid1 = "01000000-0000-7000-8000-000000000000";
    // UUID with later timestamp
    const uuid2 = "02000000-0000-7000-8000-000000000000";
    const result1 = uuidToInt64(uuid1);
    const result2 = uuidToInt64(uuid2);
    expect(result2).toBeGreaterThan(result1);
  });
});

describe("int64ToLongFormId", () => {
  it("formats as a Google Reader long-form item ID", () => {
    const id = BigInt(31);
    const result = int64ToLongFormId(id);
    expect(result).toBe("tag:google.com,2005:reader/item/000000000000001f");
  });

  it("pads to 16 hex characters", () => {
    const id = BigInt(0);
    const result = int64ToLongFormId(id);
    expect(result).toBe("tag:google.com,2005:reader/item/0000000000000000");
  });

  it("handles large values", () => {
    const id = BigInt(2) ** BigInt(62);
    const result = int64ToLongFormId(id);
    expect(result).toContain("tag:google.com,2005:reader/item/");
    // The hex should be 16 chars
    const hex = result.split("/item/")[1];
    expect(hex).toHaveLength(16);
  });
});

describe("int64ToShortHex", () => {
  it("formats as 16-char zero-padded hex", () => {
    expect(int64ToShortHex(BigInt(31))).toBe("000000000000001f");
    expect(int64ToShortHex(BigInt(255))).toBe("00000000000000ff");
    expect(int64ToShortHex(BigInt(0))).toBe("0000000000000000");
  });
});

describe("parseItemId", () => {
  it("parses long-form tag URIs", () => {
    const id = "tag:google.com,2005:reader/item/000000000000001f";
    expect(parseItemId(id)).toBe(BigInt(31));
  });

  it("parses short hex IDs", () => {
    expect(parseItemId("000000000000001f")).toBe(BigInt(31));
    expect(parseItemId("000000000000001F")).toBe(BigInt(31));
  });

  it("parses decimal strings", () => {
    expect(parseItemId("31")).toBe(BigInt(31));
    expect(parseItemId("0")).toBe(BigInt(0));
  });

  it("parses negative decimal strings", () => {
    expect(parseItemId("-1")).toBe(BigInt(-1));
  });

  it("throws on invalid format", () => {
    expect(() => parseItemId("not-valid-id")).toThrow("Invalid Google Reader item ID format");
    expect(() => parseItemId("")).toThrow("Invalid Google Reader item ID format");
    expect(() => parseItemId("abc")).toThrow("Invalid Google Reader item ID format");
  });

  it("roundtrips through int64ToLongFormId", () => {
    const original = BigInt(123456789);
    const longForm = int64ToLongFormId(original);
    const parsed = parseItemId(longForm);
    expect(parsed).toBe(original);
  });

  it("roundtrips through int64ToShortHex", () => {
    const original = BigInt(987654321);
    const shortHex = int64ToShortHex(original);
    const parsed = parseItemId(shortHex);
    expect(parsed).toBe(original);
  });

  it("roundtrips through decimal string", () => {
    const original = BigInt(42);
    const decimal = original.toString();
    const parsed = parseItemId(decimal);
    expect(parsed).toBe(original);
  });
});

describe("subscriptionToStreamId", () => {
  it("formats as feed/{int64}", () => {
    // A UUID that converts to some int64
    const uuid = "0191a2b3-c4d5-7e6f-8a9b-0c1d2e3f4a5b";
    const result = subscriptionToStreamId(uuid);
    expect(result).toMatch(/^feed\/\d+$/);
  });
});

describe("parseFeedStreamId", () => {
  it("parses feed/{int64} format", () => {
    expect(parseFeedStreamId("feed/12345")).toBe(BigInt(12345));
  });

  it("throws on non-feed stream IDs", () => {
    expect(() => parseFeedStreamId("user/-/state/com.google/read")).toThrow(
      "Invalid feed stream ID"
    );
  });
});

describe("parseStreamId", () => {
  it("parses feed stream IDs", () => {
    const result = parseStreamId("feed/12345");
    expect(result).toEqual({ type: "feed", subscriptionInt64: BigInt(12345) });
  });

  it("parses user/-/state/com.google/reading-list", () => {
    const result = parseStreamId("user/-/state/com.google/reading-list");
    expect(result).toEqual({ type: "state", state: "reading-list" });
  });

  it("parses user/-/state/com.google/starred", () => {
    const result = parseStreamId("user/-/state/com.google/starred");
    expect(result).toEqual({ type: "state", state: "starred" });
  });

  it("parses user/-/state/com.google/read", () => {
    const result = parseStreamId("user/-/state/com.google/read");
    expect(result).toEqual({ type: "state", state: "read" });
  });

  it("parses user/-/label/{name}", () => {
    const result = parseStreamId("user/-/label/Tech News");
    expect(result).toEqual({ type: "label", name: "Tech News" });
  });

  it("parses user/{userId}/label/{name} (ignores userId)", () => {
    const result = parseStreamId("user/12345/label/Science");
    expect(result).toEqual({ type: "label", name: "Science" });
  });

  it("parses user/{userId}/state/com.google/reading-list (ignores userId)", () => {
    const result = parseStreamId("user/12345/state/com.google/reading-list");
    expect(result).toEqual({ type: "state", state: "reading-list" });
  });

  it("throws on invalid stream IDs", () => {
    expect(() => parseStreamId("invalid")).toThrow("Invalid stream ID");
    expect(() => parseStreamId("")).toThrow("Invalid stream ID");
  });

  it("throws on unknown system states", () => {
    expect(() => parseStreamId("user/-/state/com.google/unknown")).toThrow("Unknown system state");
  });
});

describe("stateStreamId", () => {
  it("builds state stream IDs", () => {
    expect(stateStreamId("reading-list")).toBe("user/-/state/com.google/reading-list");
    expect(stateStreamId("starred")).toBe("user/-/state/com.google/starred");
    expect(stateStreamId("read")).toBe("user/-/state/com.google/read");
  });
});

describe("labelStreamId", () => {
  it("builds label stream IDs", () => {
    expect(labelStreamId("Tech")).toBe("user/-/label/Tech");
    expect(labelStreamId("News Feed")).toBe("user/-/label/News Feed");
  });
});

describe("isState", () => {
  it("returns true for matching states", () => {
    expect(isState("user/-/state/com.google/read", "read")).toBe(true);
    expect(isState("user/-/state/com.google/starred", "starred")).toBe(true);
  });

  it("returns false for non-matching states", () => {
    expect(isState("user/-/state/com.google/read", "starred")).toBe(false);
  });

  it("returns false for invalid stream IDs", () => {
    expect(isState("invalid", "read")).toBe(false);
  });

  it("returns false for non-state stream IDs", () => {
    expect(isState("feed/12345", "read")).toBe(false);
    expect(isState("user/-/label/News", "read")).toBe(false);
  });
});
