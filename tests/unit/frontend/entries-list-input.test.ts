/**
 * Tests for the shared entries.list input builder and URL view-preference
 * parsing, focused on the full-text search (`?q=`) behavior (#565).
 */

import { describe, expect, it } from "vitest";
import { buildEntriesListInput } from "@/lib/queries/entries-list-input";
import { parseViewPreferencesFromParams } from "@/lib/hooks/viewPreferences";

describe("parseViewPreferencesFromParams", () => {
  it("returns no searchQuery when q is absent", () => {
    const result = parseViewPreferencesFromParams(new URLSearchParams());
    expect(result.searchQuery).toBeUndefined();
    expect(result.unreadOnly).toBe(true);
    expect(result.sortOrder).toBe("newest");
  });

  it("parses and trims the q param", () => {
    const result = parseViewPreferencesFromParams(new URLSearchParams("q=%20hello%20world%20"));
    expect(result.searchQuery).toBe("hello world");
  });

  it("treats a whitespace-only q as not searching", () => {
    const result = parseViewPreferencesFromParams(new URLSearchParams("q=%20%20"));
    expect(result.searchQuery).toBeUndefined();
    expect(result.unreadOnly).toBe(true);
  });

  it("defaults unreadOnly to false while searching", () => {
    const result = parseViewPreferencesFromParams(new URLSearchParams("q=hello"));
    expect(result.unreadOnly).toBe(false);
  });

  it("keeps an explicit unreadOnly=true while searching", () => {
    const result = parseViewPreferencesFromParams(new URLSearchParams("q=hello&unreadOnly=true"));
    expect(result.unreadOnly).toBe(true);
  });

  it("ignores the route default for unreadOnly while searching", () => {
    const result = parseViewPreferencesFromParams(new URLSearchParams("q=hello"), {
      unreadOnly: true,
    });
    expect(result.unreadOnly).toBe(false);
  });
});

describe("buildEntriesListInput", () => {
  it("includes the search query in the input", () => {
    const input = buildEntriesListInput(
      { subscriptionId: "sub-1" },
      { unreadOnly: false, sortOrder: "newest", searchQuery: "hello" }
    );
    expect(input.query).toBe("hello");
    expect(input.subscriptionId).toBe("sub-1");
  });

  it("normalizes an empty or whitespace-only query to undefined", () => {
    for (const searchQuery of [undefined, "", "   "]) {
      const input = buildEntriesListInput(
        {},
        { unreadOnly: true, sortOrder: "newest", searchQuery }
      );
      expect(input.query).toBeUndefined();
    }
  });

  it("canonicalizes sortOrder and direction while searching", () => {
    const input = buildEntriesListInput(
      {},
      { unreadOnly: false, sortOrder: "oldest", searchQuery: "hello" }
    );
    expect(input.sortOrder).toBe("newest");
    expect(input.direction).toBe("forward");
  });

  it("respects sortOrder when not searching", () => {
    const input = buildEntriesListInput({}, { unreadOnly: true, sortOrder: "oldest" });
    expect(input.sortOrder).toBe("oldest");
    expect(input.direction).toBe("backward");
  });
});
