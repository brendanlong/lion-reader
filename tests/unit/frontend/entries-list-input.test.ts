/**
 * Unit tests for entries-list-input utility functions.
 *
 * Tests getFiltersFromPathname, getDefaultViewPreferences, and buildEntriesListInput.
 */

import { describe, it, expect } from "vitest";
import {
  getFiltersFromPathname,
  getDefaultViewPreferences,
  buildEntriesListInput,
} from "@/lib/queries/entries-list-input";

describe("getFiltersFromPathname", () => {
  it("returns empty filters for /all", () => {
    expect(getFiltersFromPathname("/all")).toEqual({});
  });

  it("returns subscriptionId for /subscription/:id", () => {
    expect(getFiltersFromPathname("/subscription/abc-123")).toEqual({
      subscriptionId: "abc-123",
    });
  });

  it("returns tagId for /tag/:tagId", () => {
    expect(getFiltersFromPathname("/tag/tag-456")).toEqual({ tagId: "tag-456" });
  });

  it("returns uncategorized for /tag/uncategorized", () => {
    expect(getFiltersFromPathname("/tag/uncategorized")).toEqual({ uncategorized: true });
  });

  it("returns starredOnly for /starred", () => {
    expect(getFiltersFromPathname("/starred")).toEqual({ starredOnly: true });
  });

  it("returns type saved for /saved", () => {
    expect(getFiltersFromPathname("/saved")).toEqual({ type: "saved" });
  });

  it("returns uncategorized for /uncategorized", () => {
    expect(getFiltersFromPathname("/uncategorized")).toEqual({ uncategorized: true });
  });

  it("returns sortBy readChanged for /recently-read", () => {
    expect(getFiltersFromPathname("/recently-read")).toEqual({ sortBy: "readChanged" });
  });

  it("returns sortBy predictedScore for /best", () => {
    expect(getFiltersFromPathname("/best")).toEqual({ sortBy: "predictedScore" });
  });

  it("returns empty filters for /search", () => {
    expect(getFiltersFromPathname("/search")).toEqual({});
  });

  it("returns empty filters for unknown paths", () => {
    expect(getFiltersFromPathname("/unknown")).toEqual({});
  });
});

describe("getDefaultViewPreferences", () => {
  it("defaults to unreadOnly: true for most routes", () => {
    expect(getDefaultViewPreferences("/all")).toEqual({
      unreadOnly: true,
      sortOrder: "newest",
    });
    expect(getDefaultViewPreferences("/starred")).toEqual({
      unreadOnly: true,
      sortOrder: "newest",
    });
  });

  it("defaults to unreadOnly: false for /recently-read", () => {
    expect(getDefaultViewPreferences("/recently-read")).toEqual({
      unreadOnly: false,
      sortOrder: "newest",
    });
  });

  it("defaults to unreadOnly: false for /search", () => {
    expect(getDefaultViewPreferences("/search")).toEqual({
      unreadOnly: false,
      sortOrder: "newest",
    });
  });
});

describe("buildEntriesListInput", () => {
  it("includes query when provided in filters", () => {
    const input = buildEntriesListInput(
      { query: "test search" },
      { unreadOnly: false, sortOrder: "newest" }
    );
    expect(input.query).toBe("test search");
  });

  it("sets query to undefined when not provided", () => {
    const input = buildEntriesListInput({}, { unreadOnly: true, sortOrder: "newest" });
    expect(input.query).toBeUndefined();
  });

  it("sets direction to forward for newest sort", () => {
    const input = buildEntriesListInput({}, { unreadOnly: true, sortOrder: "newest" });
    expect(input.direction).toBe("forward");
  });

  it("sets direction to backward for oldest sort", () => {
    const input = buildEntriesListInput({}, { unreadOnly: true, sortOrder: "oldest" });
    expect(input.direction).toBe("backward");
  });

  it("passes all filter fields through", () => {
    const input = buildEntriesListInput(
      {
        query: "search",
        subscriptionId: "sub-1",
        tagId: "tag-1",
        uncategorized: true,
        starredOnly: true,
        type: "web",
        sortBy: "readChanged",
      },
      { unreadOnly: false, sortOrder: "oldest" }
    );
    expect(input).toEqual({
      query: "search",
      subscriptionId: "sub-1",
      tagId: "tag-1",
      uncategorized: true,
      unreadOnly: false,
      starredOnly: true,
      sortOrder: "oldest",
      sortBy: "readChanged",
      type: "web",
      limit: 10,
      direction: "backward",
    });
  });
});
