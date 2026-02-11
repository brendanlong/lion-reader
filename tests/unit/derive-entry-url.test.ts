/**
 * Unit tests for deriveEntryUrl - GUID-as-URL fallback logic.
 */

import { describe, it, expect } from "vitest";
import { deriveEntryUrl } from "../../src/server/feed/types";

describe("deriveEntryUrl", () => {
  it("returns the link when present", () => {
    expect(
      deriveEntryUrl({
        link: "https://example.com/post-1",
        guid: "some-guid",
      })
    ).toBe("https://example.com/post-1");
  });

  it("returns the GUID when it is a valid HTTP URL and no link is present", () => {
    expect(
      deriveEntryUrl({
        guid: "https://www.stilldrinking.org/stop-talking",
      })
    ).toBe("https://www.stilldrinking.org/stop-talking");
  });

  it("returns the GUID when it is a valid HTTPS URL and no link is present", () => {
    expect(
      deriveEntryUrl({
        guid: "https://example.com/article",
      })
    ).toBe("https://example.com/article");
  });

  it("returns the GUID when it is a valid HTTP URL and no link is present", () => {
    expect(
      deriveEntryUrl({
        guid: "http://example.com/article",
      })
    ).toBe("http://example.com/article");
  });

  it("does not use non-URL GUIDs as the URL", () => {
    expect(
      deriveEntryUrl({
        guid: "urn:uuid:1225c695-cfb8-4ebb-aaaa-80da344efa6a",
      })
    ).toBeUndefined();
  });

  it("does not use non-HTTP URL GUIDs as the URL", () => {
    expect(
      deriveEntryUrl({
        guid: "ftp://example.com/file",
      })
    ).toBeUndefined();
  });

  it("returns undefined when neither link nor URL-like GUID is present", () => {
    expect(
      deriveEntryUrl({
        guid: "post-12345",
      })
    ).toBeUndefined();
  });

  it("returns undefined when entry has no link or guid", () => {
    expect(deriveEntryUrl({})).toBeUndefined();
  });

  it("prefers link over GUID even when GUID is a URL", () => {
    expect(
      deriveEntryUrl({
        link: "https://example.com/canonical",
        guid: "https://example.com/guid-url",
      })
    ).toBe("https://example.com/canonical");
  });

  it("trims whitespace from link", () => {
    expect(
      deriveEntryUrl({
        link: "  https://example.com/post  ",
      })
    ).toBe("https://example.com/post");
  });

  it("trims whitespace from GUID used as URL", () => {
    expect(
      deriveEntryUrl({
        guid: "  https://example.com/post  ",
      })
    ).toBe("https://example.com/post");
  });

  it("does not use empty link, falls back to GUID URL", () => {
    expect(
      deriveEntryUrl({
        link: "  ",
        guid: "https://example.com/post",
      })
    ).toBe("https://example.com/post");
  });
});
