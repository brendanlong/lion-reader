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
    // No sort leaves it to the list (#2064).
    expect(result.sortOrder).toBeUndefined();
  });

  it("treats a whitespace-only q as not searching", () => {
    const result = parseViewPreferencesFromParams(new URLSearchParams("q=%20%20"));
    expect(result.searchQuery).toBeUndefined();
    expect(result.unreadOnly).toBe(true);
  });

  it("parses and trims the q param", () => {
    const result = parseViewPreferencesFromParams(new URLSearchParams("q=%20hello%20world%20"));
    expect(result.searchQuery).toBe("hello world");
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
    expect(input.sortOrder).toBeUndefined();
    expect(input.direction).toBe("forward");
  });

  it("respects sortOrder when not searching", () => {
    const input = buildEntriesListInput({}, { unreadOnly: true, sortOrder: "oldest" });
    expect(input.sortOrder).toBe("oldest");
    expect(input.direction).toBe("backward");
  });
});

describe("sorting by score and position (#2064)", () => {
  it.each(["highest", "lowest", "first", "last", "oldest"] as const)("reads ?sort=%s", (sort) => {
    expect(parseViewPreferencesFromParams(new URLSearchParams(`sort=${sort}`)).sortOrder).toBe(
      sort
    );
  });

  it("ignores an unknown sort", () => {
    expect(
      parseViewPreferencesFromParams(new URLSearchParams("sort=random")).sortOrder
    ).toBeUndefined();
  });

  it("asks for the sort a direction belongs to", () => {
    const input = buildEntriesListInput(
      { tagId: "tag" },
      { unreadOnly: true, sortOrder: "lowest" }
    );
    expect(input).toMatchObject({ sortBy: "score", sortOrder: "lowest" });
  });

  it("sorts only a subscription's list by position", () => {
    expect(
      buildEntriesListInput({ subscriptionId: "c" }, { unreadOnly: true, sortOrder: "first" })
    ).toMatchObject({ sortBy: "position", sortOrder: "first" });
    expect(buildEntriesListInput({}, { unreadOnly: true, sortOrder: "first" })).toMatchObject({
      sortBy: undefined,
      sortOrder: undefined,
    });
  });

  it("keeps Recently Read sorted by when it was read", () => {
    expect(
      buildEntriesListInput({ sortBy: "readChanged" }, { unreadOnly: false, sortOrder: "highest" })
    ).toMatchObject({ sortBy: "readChanged", sortOrder: undefined });
  });
});
