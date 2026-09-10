/**
 * Unit tests for scheme-insensitive guid matching (#1535).
 */

import { describe, it, expect } from "vitest";
import {
  canonicalGuid,
  canonicalGuidSql,
  guidMatchCandidates,
  GUID_SCHEME_PATTERN,
} from "../../src/server/feed/guid-identity";

describe("canonicalGuid", () => {
  it("maps http and https spellings of a guid to the same key", () => {
    expect(canonicalGuid("http://example.com/?p=1")).toBe("https://example.com/?p=1");
    expect(canonicalGuid("https://example.com/?p=1")).toBe("https://example.com/?p=1");
    expect(canonicalGuid("HTTP://example.com/?p=1")).toBe("https://example.com/?p=1");
  });

  it("leaves non-URL guids and scheme-less guids untouched", () => {
    expect(canonicalGuid("tag:example.com,2026:post-1")).toBe("tag:example.com,2026:post-1");
    expect(canonicalGuid("example.com/?p=1")).toBe("example.com/?p=1");
    expect(canonicalGuid("yt:video:abc")).toBe("yt:video:abc");
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
  it("returns the guid plus both lowercase-scheme spellings for URL guids", () => {
    expect(guidMatchCandidates("http://example.com/?p=1")).toEqual([
      "http://example.com/?p=1",
      "https://example.com/?p=1",
    ]);
    expect(guidMatchCandidates("HTTPS://example.com/?p=1")).toEqual([
      "HTTPS://example.com/?p=1",
      "http://example.com/?p=1",
      "https://example.com/?p=1",
    ]);
  });

  it("returns only the guid itself when it has no http/https scheme", () => {
    expect(guidMatchCandidates("tag:example.com,2026:post-1")).toEqual([
      "tag:example.com,2026:post-1",
    ]);
    expect(guidMatchCandidates("example.com/?p=1")).toEqual(["example.com/?p=1"]);
  });

  it("every candidate shares the incoming guid's canonical key", () => {
    for (const guid of ["http://x/?p=1", "HTTP://x/?p=1", "https://x/?p=1", "urn:uuid:1"]) {
      for (const candidate of guidMatchCandidates(guid)) {
        expect(canonicalGuid(candidate)).toBe(canonicalGuid(guid));
      }
    }
  });
});

describe("canonicalGuidSql", () => {
  it("embeds the shared pattern with a case-insensitive replace to https://", () => {
    expect(canonicalGuidSql("e.guid")).toBe(
      `regexp_replace(e.guid, '${GUID_SCHEME_PATTERN}', 'https://', 'i')`
    );
  });
});
