/**
 * Unit tests for scheme-insensitive guid matching (#1535). The TS/SQL parity
 * check lives in the entry-processor integration tests (it needs Postgres).
 */

import { describe, it, expect } from "vitest";
import { canonicalGuid, guidMatchCandidates } from "../../src/server/feed/guid-identity";

describe("canonicalGuid", () => {
  it("maps http and https spellings of a guid to the same key", () => {
    expect(canonicalGuid("http://example.com/?p=1")).toBe("https://example.com/?p=1");
    expect(canonicalGuid("https://example.com/?p=1")).toBe("https://example.com/?p=1");
  });

  it("leaves non-URL guids and scheme-less guids untouched", () => {
    expect(canonicalGuid("tag:example.com,2026:post-1")).toBe("tag:example.com,2026:post-1");
    expect(canonicalGuid("example.com/?p=1")).toBe("example.com/?p=1");
    expect(canonicalGuid("yt:video:abc")).toBe("yt:video:abc");
  });

  it("only folds a lowercase scheme, so what it folds can be enumerated", () => {
    expect(canonicalGuid("HTTP://example.com/?p=1")).toBe("HTTP://example.com/?p=1");
  });

  it("does not touch a scheme that appears later in the guid", () => {
    expect(canonicalGuid("tag:x,2026:http://example.com/a")).toBe(
      "tag:x,2026:http://example.com/a"
    );
  });

  it("keeps host, path, query and trailing slashes as-is", () => {
    expect(canonicalGuid("http://a.example.com/post/")).not.toBe(
      canonicalGuid("http://b.example.com/post/")
    );
    expect(canonicalGuid("http://example.com/post")).not.toBe(
      canonicalGuid("http://example.com/post/")
    );
  });
});

describe("guidMatchCandidates", () => {
  it("returns both scheme spellings for URL guids", () => {
    expect(guidMatchCandidates("http://example.com/?p=1")).toEqual([
      "http://example.com/?p=1",
      "https://example.com/?p=1",
    ]);
    expect(guidMatchCandidates("https://example.com/?p=1")).toEqual([
      "http://example.com/?p=1",
      "https://example.com/?p=1",
    ]);
  });

  it("returns only the guid itself when it has no lowercase http/https scheme", () => {
    expect(guidMatchCandidates("tag:example.com,2026:post-1")).toEqual([
      "tag:example.com,2026:post-1",
    ]);
    expect(guidMatchCandidates("example.com/?p=1")).toEqual(["example.com/?p=1"]);
    expect(guidMatchCandidates("HTTPS://example.com/?p=1")).toEqual(["HTTPS://example.com/?p=1"]);
  });

  it("is exactly the set of spellings sharing the incoming guid's key", () => {
    const spellings = [
      "http://x/?p=1",
      "https://x/?p=1",
      "HTTP://x/?p=1",
      "x/?p=1",
      "urn:uuid:1",
      "http://y/?p=1",
    ];
    for (const guid of spellings) {
      const sameKey = spellings.filter((s) => canonicalGuid(s) === canonicalGuid(guid));
      const candidates = guidMatchCandidates(guid);
      for (const s of sameKey) {
        expect(candidates).toContain(s);
      }
      for (const candidate of candidates) {
        expect(canonicalGuid(candidate)).toBe(canonicalGuid(guid));
      }
    }
  });
});
